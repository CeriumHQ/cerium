import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AdapterEvent } from "@cerium/harness";
import type { EventPayload } from "@cerium/protocol";

import { LOGIN_COMMAND } from "./manifest.ts";
import { ClaudeTodos } from "./todos.ts";

/** Built-in tools whose successful result means a file in the workspace changed. */
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const AUTH_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed", "verification_required"]);

/**
 * Translates one Claude session's SDK messages into canonical events.
 *
 * Claude Code emits one `assistant` message per content block, all sharing the API message id, while
 * stream events identify blocks by index. The translator pairs them so a block's deltas and its
 * completion carry the same `messageId` (`<api message id>:<block index>`).
 */
export class ClaudeTranslator {
  #streamingMessageId: string | undefined;
  /** Block indexes seen streaming, keyed by `<api message id>|<block type>`, awaiting their completion. */
  readonly #pendingBlocks = new Map<string, Array<number>>();
  /** Fallback block numbering when partial messages are off, keyed like `#pendingBlocks`. */
  readonly #completedBlocks = new Map<string, number>();
  readonly #toolNames = new Map<string, string>();
  /** The todo tools' calls, which report the agent's todo list instead of tool calls. */
  readonly #todos = new ClaudeTodos();
  /** Claude Code repeats `init` every turn; only the first starts the session. */
  #started = false;
  /** `total_cost_usd` is cumulative for the session; turns report the difference. */
  #costSoFar = 0;

  translate(message: SDKMessage): ReadonlyArray<AdapterEvent> {
    return this.#payloads(message).map((payload) => ({ payload, raw: message }));
  }

  #payloads(message: SDKMessage): ReadonlyArray<EventPayload> {
    switch (message.type) {
      case "system":
        if (message.subtype !== "init" || this.#started) return [];
        this.#started = true;
        return [
          {
            _tag: "SessionStarted",
            provider: "claude",
            providerSessionId: message.session_id,
            model: message.model,
          },
        ];
      case "stream_event":
        return message.parent_tool_use_id === null ? this.#streamEvent(message.event) : [];
      case "assistant":
        return message.parent_tool_use_id === null ? this.#assistant(message) : [];
      case "user":
        return message.parent_tool_use_id === null ? this.#toolResults(message) : [];
      case "result":
        return this.#result(message);
      case "rate_limit_event":
        return message.rate_limit_info.status === "rejected"
          ? [
              {
                _tag: "AgentError",
                kind: "rateLimit",
                message: `Claude ${message.rate_limit_info.rateLimitType ?? "usage"} limit reached`,
                retryable: true,
              },
            ]
          : [];
      case "auth_status":
        return message.error === undefined
          ? []
          : [
              {
                _tag: "AuthRequired",
                provider: "claude",
                reason: message.error,
                loginCommand: LOGIN_COMMAND,
              },
            ];
      default:
        return [];
    }
  }

  #streamEvent(event: Extract<SDKMessage, { type: "stream_event" }>["event"]): ReadonlyArray<EventPayload> {
    switch (event.type) {
      case "message_start":
        this.#streamingMessageId = event.message.id;
        return [];
      case "content_block_start": {
        const { type } = event.content_block;
        if ((type === "text" || type === "thinking") && this.#streamingMessageId !== undefined) {
          const key = `${this.#streamingMessageId}|${type}`;
          this.#pendingBlocks.set(key, [...(this.#pendingBlocks.get(key) ?? []), event.index]);
        }
        return [];
      }
      case "content_block_delta": {
        if (this.#streamingMessageId === undefined) return [];
        const messageId = `${this.#streamingMessageId}:${event.index}`;
        if (event.delta.type === "text_delta" && event.delta.text !== "") {
          return [{ _tag: "MessageDelta", messageId, text: event.delta.text }];
        }
        if (event.delta.type === "thinking_delta" && event.delta.thinking !== "") {
          return [{ _tag: "ReasoningDelta", messageId, text: event.delta.thinking }];
        }
        return [];
      }
      default:
        return [];
    }
  }

  #assistant(message: Extract<SDKMessage, { type: "assistant" }>): ReadonlyArray<EventPayload> {
    if (message.error !== undefined) {
      return [
        AUTH_ERRORS.has(message.error)
          ? { _tag: "AuthRequired", provider: "claude", reason: message.error, loginCommand: LOGIN_COMMAND }
          : {
              _tag: "AgentError",
              kind: message.error === "rate_limit" ? "rateLimit" : "unknown",
              message: message.error,
              retryable: message.error === "rate_limit" || message.error === "overloaded",
            },
      ];
    }

    const apiMessageId = message.message.id;
    return message.message.content.flatMap((block): ReadonlyArray<EventPayload> => {
      switch (block.type) {
        case "text":
          return [
            { _tag: "MessageCompleted", messageId: this.#blockId(apiMessageId, "text"), text: block.text },
          ];
        case "thinking": {
          const messageId = this.#blockId(apiMessageId, "thinking");
          return block.thinking === ""
            ? []
            : [{ _tag: "ReasoningCompleted", messageId, text: block.thinking }];
        }
        case "tool_use":
        case "server_tool_use":
        case "mcp_tool_use":
          if (block.type === "tool_use" && this.#todos.call(block.id, block.name, block.input)) return [];
          this.#toolNames.set(block.id, block.name);
          return [{ _tag: "ToolCallStarted", callId: block.id, toolName: block.name, input: block.input }];
        default:
          return [];
      }
    });
  }

  #blockId(apiMessageId: string, type: "text" | "thinking"): string {
    const key = `${apiMessageId}|${type}`;
    const index = this.#pendingBlocks.get(key)?.shift();
    if (index !== undefined) return `${apiMessageId}:${index}`;
    const completed = this.#completedBlocks.get(key) ?? 0;
    this.#completedBlocks.set(key, completed + 1);
    return `${apiMessageId}:${type === "text" ? "t" : "r"}${completed}`;
  }

  #toolResults(message: Extract<SDKMessage, { type: "user" }>): ReadonlyArray<EventPayload> {
    const content = message.message.content;
    if (typeof content === "string") return [];

    return content.flatMap((block): ReadonlyArray<EventPayload> => {
      if (block.type !== "tool_result") return [];
      const todos = this.#todos.result(block.tool_use_id, block, message.tool_use_result);
      if (todos !== undefined) return todos;
      const isError = block.is_error === true;
      const completed: EventPayload = {
        _tag: "ToolCallCompleted",
        callId: block.tool_use_id,
        output: block.content,
        isError,
      };
      const toolName = this.#toolNames.get(block.tool_use_id);
      this.#toolNames.delete(block.tool_use_id);
      const changed =
        !isError && toolName !== undefined && FILE_TOOLS.has(toolName)
          ? fileChange(message.tool_use_result)
          : undefined;
      return changed === undefined ? [completed] : [completed, changed];
    });
  }

  #result(message: SDKResultMessage): ReadonlyArray<EventPayload> {
    const { usage } = message;
    const turnCost = Math.max(0, message.total_cost_usd - this.#costSoFar);
    this.#costSoFar = Math.max(this.#costSoFar, message.total_cost_usd);
    return [
      {
        _tag: "UsageReported",
        inputTokens: usage.input_tokens + usage.cache_creation_input_tokens,
        outputTokens: usage.output_tokens,
        cachedInputTokens: usage.cache_read_input_tokens,
        costUsd: turnCost,
      },
      { _tag: "TurnCompleted", stopReason: stopReason(message) },
    ];
  }
}

/** Reads the structured result Claude Code attaches to file tool results. */
const fileChange = (toolUseResult: unknown): EventPayload | undefined => {
  if (typeof toolUseResult !== "object" || toolUseResult === null) return undefined;
  const result = toolUseResult as { readonly filePath?: unknown; readonly type?: unknown };
  if (typeof result.filePath !== "string" || result.filePath === "") return undefined;
  return {
    _tag: "FileChanged",
    path: result.filePath,
    change: result.type === "create" ? "created" : "modified",
  };
};

const stopReason = (message: SDKResultMessage) => {
  if (message.subtype === "error_max_turns") return "maxTurns";
  // An interrupt during a tool call reports `error_during_execution` with `aborted_tools`.
  if (message.terminal_reason?.startsWith("aborted") === true) return "interrupted";
  if (message.subtype !== "success") return "error";
  return message.is_error ? "error" : "completed";
};
