import type { SDKMessage, SDKRateLimitInfo, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AdapterEvent } from "@cerium/harness";
import type { BackgroundTask, ContextCompacted, EventPayload } from "@cerium/protocol";

import { LOGIN_COMMAND } from "./manifest.ts";
import { ClaudeTodos } from "./todos.ts";

/** Built-in tools whose successful result means a file in the workspace changed. */
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** The limits Claude Code names, as the user knows them. */
const LIMIT_WINDOWS: Record<NonNullable<SDKRateLimitInfo["rateLimitType"]>, string> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly Opus",
  seven_day_sonnet: "Weekly Sonnet",
  seven_day_overage_included: "Weekly",
  overage: "Extra usage",
};

/** A reset time as epoch milliseconds, from Claude Code's seconds (or milliseconds). */
const epochMillis = (value: number): number | undefined =>
  Number.isFinite(value) && value > 0 ? Math.round(value < 1e11 ? value * 1000 : value) : undefined;

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
  /** The command lines of shell and monitor calls, by tool call, until their task ends. */
  readonly #commands = new Map<string, string>();
  /** The live background tasks, as Claude Code last listed them. */
  #background: ReadonlyArray<SDKBackgroundTask> = [];
  /** What the list leaves out of each live task: its tool call, and when it was first seen. */
  readonly #taskFacts = new Map<string, { callId?: string; readonly startedAt: number }>();
  /** Claude Code repeats `init` every turn; only the first starts the session. */
  #started = false;
  /** `total_cost_usd` is cumulative for the session; turns report the difference. */
  #costSoFar: number | undefined;
  constructor(options: { readonly resumed?: boolean } = {}) {
    // A resumed SDK may restore cumulative spend. The first delta is unknown, not all past spend.
    this.#costSoFar = options.resumed ? undefined : 0;
  }
  /** The limit this turn ran into, so it is reported once. */
  #limitHit: { readonly window?: string; readonly resetsAt?: number } | undefined;
  /** The model the session runs, which each turn's `init` names. */
  #model: string | undefined;
  /** The window Claude Code measures its context against, as it last reported it (`measured`). */
  #window: number | undefined;
  /** The tokens of the latest request's prompt, from its `message_start`. */
  #prompt: number | undefined;
  /**
   * A compaction whose boundary arrived, with the summary Claude Code put in the conversation after
   * it. The context's next reading completes it: the prompt of the request after it, or the
   * measurement after the compaction's own turn.
   */
  #compaction: Omit<ContextCompacted, "_tag" | "tokensAfter"> | undefined;

  translate(message: SDKMessage): ReadonlyArray<AdapterEvent> {
    return this.#payloads(message).map((payload) => ({ payload, raw: message }));
  }

  /**
   * Claude Code's own measure of the context (`getContextUsage`), taken as each turn ends; `undefined`
   * when it couldn't say. It completes a compaction waiting on its size.
   */
  measured(
    reading: { readonly tokens: number; readonly window: number } | undefined,
  ): ReadonlyArray<AdapterEvent> {
    if (reading === undefined) return this.#flushCompaction(undefined).map((payload) => ({ payload }));
    if (reading.window >= 1) this.#window = Math.round(reading.window);
    const tokens = count(reading.tokens);
    return [...this.#flushCompaction(tokens), this.#contextReported(tokens)].map((payload) => ({ payload }));
  }

  #flushCompaction(tokensAfter: number | undefined): ReadonlyArray<EventPayload> {
    const compaction = this.#compaction;
    this.#compaction = undefined;
    if (compaction === undefined) return [];
    return [
      { _tag: "ContextCompacted", ...compaction, ...(tokensAfter === undefined ? {} : { tokensAfter }) },
    ];
  }

  #payloads(message: SDKMessage): ReadonlyArray<EventPayload> {
    // The conversation's synthetic first message after a compaction is its summary, shown nowhere else.
    const content = message.type === "user" ? message.message.content : undefined;
    if (
      this.#compaction !== undefined &&
      this.#compaction.summary === undefined &&
      typeof content === "string"
    ) {
      const summary = compactSummary(content);
      if (summary !== undefined) {
        this.#compaction = { ...this.#compaction, summary };
        return [];
      }
    }
    switch (message.type) {
      case "system":
        if (message.subtype === "compact_boundary") {
          const flushed = this.#flushCompaction(undefined);
          // Claude Code's own count after it leaves out the system prompt and tools, which the counts
          // before it and every reading include; the next reading says the size instead.
          const { trigger, pre_tokens } = message.compact_metadata;
          this.#compaction = {
            trigger: trigger === "manual" ? "manual" : "auto",
            tokensBefore: count(pre_tokens),
          };
          return flushed;
        }
        if (message.subtype === "status" && message.compact_result === "failed") {
          return [
            {
              _tag: "AgentError",
              kind: "unknown",
              message: `Claude Code couldn't compact the conversation${message.compact_error ? `: ${message.compact_error}` : "."}`,
              retryable: false,
            },
          ];
        }
        if (message.subtype === "background_tasks_changed") return this.#backgroundChanged(message.tasks);
        if (message.subtype === "task_started") return this.#taskStarted(message);
        if (message.subtype !== "init") return [];
        // Each turn's `init` names the model it runs, and another model has another window.
        if (message.model !== this.#model) this.#window = undefined;
        this.#model = message.model;
        if (this.#started) return [];
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
        return message.rate_limit_info.status === "rejected" ? this.#limit(message.rate_limit_info) : [];
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
      case "message_start": {
        this.#streamingMessageId = event.message.id;
        // Absent from messages recorded before Cerium read usage.
        const usage: Partial<typeof event.message.usage> | undefined = event.message.usage;
        this.#prompt =
          usage?.input_tokens === undefined
            ? undefined
            : usage.input_tokens +
              (usage.cache_creation_input_tokens ?? 0) +
              (usage.cache_read_input_tokens ?? 0);
        // The first request after a compaction reads what it left.
        return this.#prompt === undefined ? [] : this.#flushCompaction(count(this.#prompt));
      }
      case "message_delta": {
        // The request's whole context: what it read, and what it wrote, which the next one reads.
        const usage: Partial<typeof event.usage> | undefined = event.usage;
        if (this.#prompt === undefined) return [];
        const tokens = count(this.#prompt + (usage?.output_tokens ?? 0));
        this.#prompt = undefined;
        return [this.#contextReported(tokens)];
      }
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
    if (message.error === "rate_limit" && this.#limitHit === undefined) {
      // The rejected-limit event normally comes first; without it, the error alone says the limit ran out.
      return this.#limit(undefined);
    }
    if (message.error === "rate_limit") return [];
    if (message.error !== undefined) {
      return [
        AUTH_ERRORS.has(message.error)
          ? { _tag: "AuthRequired", provider: "claude", reason: message.error, loginCommand: LOGIN_COMMAND }
          : {
              _tag: "AgentError",
              kind: message.error === "overloaded" ? "transient" : "unknown",
              message: message.error,
              retryable: message.error === "overloaded",
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
          if (block.type === "tool_use" && COMMAND_TOOLS.has(block.name)) {
            const command = (block.input as { readonly command?: unknown } | null)?.command;
            if (typeof command === "string" && command !== "") this.#commands.set(block.id, command);
          }
          return [{ _tag: "ToolCallStarted", callId: block.id, toolName: block.name, input: block.input }];
        default:
          return [];
      }
    });
  }

  #blockId(apiMessageId: string, type: "text" | "thinking"): string {
    const key = `${apiMessageId}|${type}`;
    const pending = this.#pendingBlocks.get(key);
    const index = pending?.shift();
    // An emptied list reads as no list, so it isn't kept for every message of a long session.
    if (pending?.length === 0) this.#pendingBlocks.delete(key);
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
      // A command that went on in the background keeps its line for the task's row.
      if (![...this.#taskFacts.values()].some((facts) => facts.callId === block.tool_use_id))
        this.#commands.delete(block.tool_use_id);
      const changed =
        !isError && toolName !== undefined && FILE_TOOLS.has(toolName)
          ? fileChange(message.tool_use_result)
          : undefined;
      return changed === undefined ? [completed] : [completed, changed];
    });
  }

  /** Claude Code's whole set of live background tasks, which replaces the one before. */
  #backgroundChanged(tasks: ReadonlyArray<SDKBackgroundTask>): ReadonlyArray<EventPayload> {
    // Housekeeping tasks aren't the agent's work.
    this.#background = tasks.filter((task) => task.ambient !== true);
    const live = new Set(this.#background.map((task) => task.task_id));
    for (const [id, facts] of this.#taskFacts) {
      if (live.has(id)) continue;
      this.#taskFacts.delete(id);
      if (facts.callId !== undefined) this.#commands.delete(facts.callId);
    }
    const now = Date.now();
    for (const task of this.#background)
      if (!this.#taskFacts.has(task.task_id)) this.#taskFacts.set(task.task_id, { startedAt: now });
    return [this.#backgroundTasks()];
  }

  /**
   * A task's start names the tool call behind it, which the set leaves out; a task that already
   * joined the set (it joins before its start arrives) is listed again with its command.
   */
  #taskStarted(message: Extract<SDKMessage, { subtype: "task_started" }>): ReadonlyArray<EventPayload> {
    if (message.tool_use_id === undefined) return [];
    const facts = this.#taskFacts.get(message.task_id);
    if (facts === undefined) {
      this.#taskFacts.set(message.task_id, { callId: message.tool_use_id, startedAt: Date.now() });
      return [];
    }
    if (facts.callId === message.tool_use_id) return [];
    facts.callId = message.tool_use_id;
    return this.#background.some((task) => task.task_id === message.task_id) ? [this.#backgroundTasks()] : [];
  }

  #backgroundTasks(): EventPayload {
    return {
      _tag: "BackgroundTasksChanged",
      tasks: this.#background.map((task): BackgroundTask => {
        const facts = this.#taskFacts.get(task.task_id);
        const command = facts?.callId === undefined ? undefined : this.#commands.get(facts.callId);
        return {
          id: task.task_id,
          kind: taskKind(task.task_type),
          description: task.description,
          ...(command !== undefined && command !== task.description ? { command } : {}),
          ...(facts?.callId === undefined ? {} : { callId: facts.callId }),
          ...(facts === undefined ? {} : { startedAt: facts.startedAt }),
          stoppable: true,
        };
      }),
    };
  }

  /** One `LimitReached` for the turn: the rejected-limit event and the error after it say the same. */
  #limit(info: SDKRateLimitInfo | undefined): ReadonlyArray<EventPayload> {
    if (this.#limitHit !== undefined) return [];
    const window = info?.rateLimitType === undefined ? undefined : LIMIT_WINDOWS[info.rateLimitType];
    const resetsAt = info?.resetsAt === undefined ? undefined : epochMillis(info.resetsAt);
    this.#limitHit = { ...(window ? { window } : {}), ...(resetsAt ? { resetsAt } : {}) };
    return [
      {
        _tag: "LimitReached",
        provider: "claude",
        ...this.#limitHit,
        message: `Claude ${window ?? "usage"} limit reached`,
      },
    ];
  }

  #result(message: SDKResultMessage): ReadonlyArray<EventPayload> {
    this.#limitHit = undefined;
    const { usage } = message;
    const turnCost =
      this.#costSoFar === undefined ? undefined : Math.max(0, message.total_cost_usd - this.#costSoFar);
    this.#costSoFar = Math.max(this.#costSoFar ?? 0, message.total_cost_usd);
    return [
      {
        _tag: "UsageReported",
        inputTokens: usage.input_tokens + usage.cache_creation_input_tokens,
        outputTokens: usage.output_tokens,
        cachedInputTokens: usage.cache_read_input_tokens,
        ...(turnCost === undefined ? {} : { costUsd: turnCost }),
      },
      { _tag: "TurnCompleted", stopReason: stopReason(message) },
    ];
  }

  #contextReported(tokens: number): EventPayload {
    return {
      _tag: "ContextReported",
      tokens,
      ...(this.#window === undefined ? {} : { window: this.#window }),
    };
  }
}

type SDKBackgroundTask = Extract<SDKMessage, { subtype: "background_tasks_changed" }>["tasks"][number];

/** Built-in tools whose input names the command a background task runs. */
const COMMAND_TOOLS = new Set(["Bash", "Monitor"]);

const taskKind = (type: string): BackgroundTask["kind"] => {
  if (type === "local_bash") return "command";
  if (type.includes("monitor")) return "monitor";
  if (type.includes("agent") || type.includes("teammate")) return "agent";
  return "other";
};

const count = (value: number) => Math.max(0, Math.round(value));

/**
 * What Claude Code tells the model a compacted conversation was, without the preamble before it or
 * the instructions after it (where to read the full transcript, to carry on without recapping).
 */
const SUMMARY_PREAMBLE = /^This session is being continued from a previous conversation[^\n]*\n/;
const SUMMARY_AFTERWORD =
  /\n\s*(?:If you need specific details from before compaction|Continue the conversation from where it left off)/;

const compactSummary = (content: string): string | undefined => {
  if (!SUMMARY_PREAMBLE.test(content)) return undefined;
  const marker = content.indexOf("\nSummary:\n");
  const body = marker === -1 ? content.replace(SUMMARY_PREAMBLE, "") : content.slice(marker + 10);
  const end = body.search(SUMMARY_AFTERWORD);
  return (end === -1 ? body : body.slice(0, end)).trim();
};

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
