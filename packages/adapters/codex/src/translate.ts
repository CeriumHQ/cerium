import type { AdapterEvent } from "@cerium/harness";
import { sameTodos, type ContextCompacted, type EventPayload, type TodoItem } from "@cerium/protocol";

import { fromCodexEffort } from "./config.ts";
import { LOGIN_COMMAND } from "./manifest.ts";
import { windowLabel } from "./usage.ts";
import type { ServerNotification } from "./protocol/ServerNotification.ts";
import type { CodexErrorInfo } from "./protocol/v2/CodexErrorInfo.ts";
import type { RateLimitSnapshot } from "./protocol/v2/RateLimitSnapshot.ts";
import type { ThreadItem } from "./protocol/v2/ThreadItem.ts";
import type { ThreadResumeResponse } from "./protocol/v2/ThreadResumeResponse.ts";
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse.ts";
import type { ThreadTokenUsage } from "./protocol/v2/ThreadTokenUsage.ts";
import type { TurnError } from "./protocol/v2/TurnError.ts";
import type { TurnPlanUpdatedNotification } from "./protocol/v2/TurnPlanUpdatedNotification.ts";

type ToolItem = Extract<
  ThreadItem,
  {
    type:
      | "commandExecution"
      | "fileChange"
      | "mcpToolCall"
      | "dynamicToolCall"
      | "collabAgentToolCall"
      | "webSearch"
      | "imageView"
      | "imageGeneration"
      | "sleep";
  }
>;
type McpToolCall = Extract<ThreadItem, { type: "mcpToolCall" }>;
type Reasoning = Extract<ThreadItem, { type: "reasoning" }>;

const TOOL_TYPES: ReadonlySet<ThreadItem["type"]> = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
  "sleep",
]);
const isToolItem = (item: ThreadItem): item is ToolItem => TOOL_TYPES.has(item.type);

/**
 * Translates one app-server thread's notifications into canonical events.
 *
 * Items carry stable ids across `item/started`, their deltas and `item/completed`, so those ids are
 * the canonical `messageId`s and `callId`s. Token usage arrives once per model response as running
 * thread totals; each turn reports its own difference.
 */
export class CodexTranslator {
  #threadId: string | undefined;
  /** Items between `item/started` and `item/completed`: approval requests only name the item. */
  readonly #items = new Map<string, { readonly item: ThreadItem; readonly turnId: string }>();
  /** Which reasoning stream an item's deltas come from, and the summary part they are in. */
  readonly #reasoning = new Map<string, { readonly source: "summary" | "content"; readonly part: number }>();
  /** The first and latest usage update of each running turn. */
  readonly #usage = new Map<string, { readonly first: ThreadTokenUsage; latest: ThreadTokenUsage }>();
  /** The plan's limits as Codex last reported them, by bucket, which say when a limit that ran out resets. */
  readonly #limits = new Map<string, RateLimitSnapshot>();
  /** Turns whose failure was already reported by an `error` notification. */
  readonly #reportedErrors = new Set<string>();
  /** The context as the latest usage update measured it. */
  #context: number | undefined;
  /** Cerium asked for the next compaction (`thread/compact/start`); Codex's others are its own. */
  #compactAsked = false;
  /**
   * A compaction that finished, until the usage update Codex sends for the history it left reports
   * its size; the turn's end or its next item reports it without.
   */
  #compaction: Omit<ContextCompacted, "_tag"> | undefined;
  /** The plan as last reported, which a repeated `turn/plan/updated` leaves as it is. */
  #plan: { readonly items: ReadonlyArray<TodoItem>; readonly explanation: string | undefined } = {
    items: [],
    explanation: undefined,
  };

  /** The `thread/start` or `thread/resume` response starts the session. */
  started(response: ThreadStartResponse | ThreadResumeResponse): ReadonlyArray<AdapterEvent> {
    if (this.#threadId !== undefined) return [];
    this.#threadId = response.thread.id;
    const effort = fromCodexEffort(response.reasoningEffort);
    return [
      {
        payload: {
          _tag: "SessionStarted",
          provider: "codex",
          providerSessionId: response.thread.id,
          model: response.model,
          ...(effort ? { effort } : {}),
        },
        raw: response,
      },
    ];
  }

  translate(notification: ServerNotification): ReadonlyArray<AdapterEvent> {
    return this.#payloads(notification).map((payload) => ({ payload, raw: notification }));
  }

  /** The session asked Codex to compact: the next compaction is the user's. */
  compactAsked(): void {
    this.#compactAsked = true;
  }

  /** The finished compaction, reported without a size after it when nothing measured one. */
  #flushCompaction(): ReadonlyArray<EventPayload> {
    const compaction = this.#compaction;
    this.#compaction = undefined;
    return compaction === undefined ? [] : [{ _tag: "ContextCompacted", ...compaction }];
  }

  /** A tool item that has started and not completed. */
  item(itemId: string): ThreadItem | undefined {
    return this.#items.get(itemId)?.item;
  }

  /** The latest running MCP tool call on `server`, which an approval elicitation is about. */
  runningMcpCall(server: string): McpToolCall | undefined {
    let found: McpToolCall | undefined;
    for (const { item } of this.#items.values()) {
      if (item.type === "mcpToolCall" && item.server === server) found = item;
    }
    return found;
  }

  #payloads(notification: ServerNotification): ReadonlyArray<EventPayload> {
    const { params } = notification;
    // One app-server process hosts one Cerium session; other threads (if any) are not ours.
    if (
      this.#threadId !== undefined &&
      typeof params === "object" &&
      params !== null &&
      "threadId" in params &&
      typeof params.threadId === "string" &&
      params.threadId !== this.#threadId
    ) {
      return [];
    }

    switch (notification.method) {
      case "item/started": {
        const { item, turnId } = notification.params;
        if (!isToolItem(item)) return item.type === "contextCompaction" ? [] : this.#flushCompaction();
        this.#items.set(item.id, { item, turnId });
        return [...this.#flushCompaction(), toolStarted(item)];
      }
      case "item/completed":
        if (notification.params.item.type === "contextCompaction") {
          const flushed = this.#flushCompaction();
          this.#compaction = {
            trigger: this.#compactAsked ? "manual" : "auto",
            ...(this.#context === undefined ? {} : { tokensBefore: this.#context }),
          };
          this.#compactAsked = false;
          this.#context = undefined;
          return flushed;
        }
        return this.#itemCompleted(notification.params.item);
      case "item/agentMessage/delta": {
        const { itemId, delta } = notification.params;
        return delta === "" ? [] : [{ _tag: "MessageDelta", messageId: itemId, text: delta }];
      }
      case "item/reasoning/summaryTextDelta":
        return this.#reasoningDelta(
          notification.params.itemId,
          "summary",
          notification.params.summaryIndex,
          notification.params.delta,
        );
      case "item/reasoning/textDelta":
        return this.#reasoningDelta(
          notification.params.itemId,
          "content",
          notification.params.contentIndex,
          notification.params.delta,
        );
      case "thread/tokenUsage/updated": {
        const { turnId, tokenUsage } = notification.params;
        const usage = this.#usage.get(turnId);
        if (usage === undefined) this.#usage.set(turnId, { first: tokenUsage, latest: tokenUsage });
        else usage.latest = tokenUsage;
        // The latest request's whole context: what it read and what it wrote.
        const tokens = Math.max(0, Math.round(tokenUsage.last.totalTokens));
        const window = tokenUsage.modelContextWindow;
        this.#context = tokens;
        const compaction = this.#compaction;
        this.#compaction = undefined;
        return [
          ...(compaction === undefined
            ? []
            : [{ _tag: "ContextCompacted", ...compaction, tokensAfter: tokens } as const]),
          {
            _tag: "ContextReported",
            tokens,
            ...(window !== null && window >= 1 ? { window: Math.round(window) } : {}),
          },
        ];
      }
      case "error": {
        const { error, willRetry, turnId } = notification.params;
        if (willRetry) return [];
        this.#reportedErrors.add(turnId);
        return [turnError(error, this.#limits)];
      }
      case "account/rateLimits/updated": {
        const { rateLimits } = notification.params;
        this.#limits.set(rateLimits.limitId ?? "codex", rateLimits);
        return [];
      }
      case "turn/plan/updated":
        return this.#planUpdated(notification.params);
      case "turn/completed":
        return this.#turnCompleted(notification.params.turn);
      case "account/updated":
        return notification.params.authMode === null
          ? [{ _tag: "AuthRequired", provider: "codex", reason: "loggedOut", loginCommand: LOGIN_COMMAND }]
          : [];
      default:
        return [];
    }
  }

  /**
   * The plan the agent keeps with `update_plan`: the whole list at every call, with the reason it
   * changed. (Not Plan mode's plan text, which arrives as `item/plan/delta`.)
   */
  #planUpdated({ plan, explanation }: TurnPlanUpdatedNotification): ReadonlyArray<EventPayload> {
    const items = plan.map((step): TodoItem => ({ text: step.step, status: step.status }));
    const reason = explanation === null || explanation.trim() === "" ? undefined : explanation;
    if (sameTodos(this.#plan.items, items) && this.#plan.explanation === reason) return [];
    this.#plan = { items, explanation: reason };
    return [{ _tag: "TodosUpdated", items, ...(reason === undefined ? {} : { explanation: reason }) }];
  }

  #itemCompleted(item: ThreadItem): ReadonlyArray<EventPayload> {
    switch (item.type) {
      case "agentMessage":
        return [{ _tag: "MessageCompleted", messageId: item.id, text: item.text }];
      case "reasoning": {
        const text = this.#reasoningText(item);
        this.#reasoning.delete(item.id);
        return text === "" ? [] : [{ _tag: "ReasoningCompleted", messageId: item.id, text }];
      }
      default: {
        if (!isToolItem(item)) return [];
        const started = this.#items.delete(item.id) ? [] : [toolStarted(item)];
        return [...started, toolCompleted(item), ...fileChanges(item)];
      }
    }
  }

  /**
   * Reasoning arrives as summary parts or (for models that expose it) raw content; an item streams
   * from whichever arrives first. Parts are separated like the completed item's text.
   */
  #reasoningDelta(
    itemId: string,
    source: "summary" | "content",
    part: number,
    delta: string,
  ): ReadonlyArray<EventPayload> {
    const state = this.#reasoning.get(itemId);
    if (state !== undefined && state.source !== source) return [];
    const separator = state !== undefined && state.part !== part ? "\n\n" : "";
    this.#reasoning.set(itemId, { source, part });
    const text = `${separator}${delta}`;
    return text === "" ? [] : [{ _tag: "ReasoningDelta", messageId: itemId, text }];
  }

  #reasoningText(item: Reasoning): string {
    const source = this.#reasoning.get(item.id)?.source;
    const summary = item.summary.join("\n\n");
    const content = item.content.join("\n\n");
    if (source === "content") return content;
    return summary === "" ? content : summary;
  }

  #turnCompleted(turn: {
    readonly id: string;
    readonly status: string;
    readonly error: TurnError | null;
  }): ReadonlyArray<EventPayload> {
    // Tool calls an interruption cut short never complete on their own.
    const unfinished: Array<EventPayload> = [];
    for (const [callId, entry] of this.#items) {
      if (entry.turnId !== turn.id) continue;
      this.#items.delete(callId);
      unfinished.push({ _tag: "ToolCallCompleted", callId, output: { status: turn.status }, isError: true });
    }

    const failed = turn.status === "failed" && turn.error !== null && !this.#reportedErrors.has(turn.id);
    this.#reportedErrors.delete(turn.id);
    const usage = this.#usage.get(turn.id);
    this.#usage.delete(turn.id);

    return [
      ...unfinished,
      ...this.#flushCompaction(),
      ...(failed && turn.error !== null ? [turnError(turn.error, this.#limits)] : []),
      turnUsage(usage),
      { _tag: "TurnCompleted", stopReason: stopReason(turn.status) },
    ];
  }
}

const stopReason = (status: string) => {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    default:
      return "error";
  }
};

/**
 * Usage notifications carry running thread totals plus the latest response's own (`last`) counts, so
 * a turn's usage is its final total minus the total before its first response. That stays right
 * after a resume, where the totals include earlier sessions. Codex's input count includes cache reads.
 */
const turnUsage = (
  usage: { readonly first: ThreadTokenUsage; readonly latest: ThreadTokenUsage } | undefined,
): EventPayload => {
  if (usage === undefined) return { _tag: "UsageReported", inputTokens: 0, outputTokens: 0 };
  const { first, latest } = usage;
  const delta = (key: "inputTokens" | "cachedInputTokens" | "outputTokens") =>
    Math.max(0, latest.total[key] - (first.total[key] - first.last[key]));
  const cached = delta("cachedInputTokens");
  return {
    _tag: "UsageReported",
    inputTokens: Math.max(0, delta("inputTokens") - cached),
    outputTokens: delta("outputTokens"),
    cachedInputTokens: cached,
  };
};

const RETRYABLE_ERRORS: ReadonlySet<string> = new Set([
  "serverOverloaded",
  "internalServerError",
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
]);

const errorCode = (info: CodexErrorInfo | null): string | undefined => {
  if (info === null) return undefined;
  if (typeof info === "string") return info;
  return Object.keys(info)[0];
};

/**
 * Which limit ran out and when it resets, from the limits Codex last reported: the windows at their
 * limit, and the latest of their resets, as that is when the turn can go on.
 */
export const exhaustedLimit = (
  limits: ReadonlyMap<string, RateLimitSnapshot>,
): { readonly window?: string; readonly resetsAt?: number } => {
  const exhausted = [...limits.values()].flatMap((snapshot) =>
    [snapshot.primary, snapshot.secondary].flatMap((window) =>
      window !== null && window.usedPercent >= 100 ? [window] : [],
    ),
  );
  const resets = exhausted.flatMap((window) =>
    window.resetsAt !== null && window.resetsAt > 0 ? [window.resetsAt] : [],
  );
  const longest = exhausted.toSorted((a, b) => (b.windowDurationMins ?? 0) - (a.windowDurationMins ?? 0))[0];
  return {
    ...(longest === undefined || longest.windowDurationMins === null
      ? {}
      : { window: windowLabel(longest.windowDurationMins).replace(/ limit$/, "") }),
    ...(resets.length === 0 ? {} : { resetsAt: Math.round(Math.max(...resets) * 1000) }),
  };
};

const turnError = (error: TurnError, limits: ReadonlyMap<string, RateLimitSnapshot>): EventPayload => {
  const code = errorCode(error.codexErrorInfo);
  const message = error.additionalDetails ? `${error.message} (${error.additionalDetails})` : error.message;
  if (code === "unauthorized") {
    return { _tag: "AuthRequired", provider: "codex", reason: message, loginCommand: LOGIN_COMMAND };
  }
  if (code === "usageLimitExceeded") {
    return { _tag: "LimitReached", provider: "codex", ...exhaustedLimit(limits), message };
  }
  if (code === "rateLimitExceeded") {
    return { _tag: "AgentError", kind: "rateLimit", message, retryable: true };
  }
  if (code !== undefined && RETRYABLE_ERRORS.has(code)) {
    return { _tag: "AgentError", kind: "transient", message, retryable: true };
  }
  return { _tag: "AgentError", kind: "unknown", message, retryable: false };
};

/**
 * The command as the agent wrote it. Codex wraps it in the user's shell (`pwsh -Command '…'`) and
 * parses it into actions; a single action is the unwrapped command.
 */
const displayCommand = (item: Extract<ThreadItem, { type: "commandExecution" }>) => {
  const [only, ...rest] = item.commandActions;
  return only !== undefined && rest.length === 0 ? only.command : item.command;
};

/** Tool names follow the model-facing Codex tools, and Claude's `mcp__<server>__<tool>` for MCP. */
const toolCall = (item: ToolItem): { readonly toolName: string; readonly input: unknown } => {
  switch (item.type) {
    case "commandExecution":
      return {
        toolName: "exec_command",
        input: { command: displayCommand(item), cwd: item.cwd, actions: item.commandActions },
      };
    case "fileChange":
      return { toolName: "apply_patch", input: { changes: item.changes } };
    case "mcpToolCall":
      return { toolName: `mcp__${item.server}__${item.tool}`, input: item.arguments };
    case "dynamicToolCall":
      return {
        toolName: item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
        input: item.arguments,
      };
    case "collabAgentToolCall":
      return { toolName: `collaboration.${item.tool}`, input: { prompt: item.prompt, model: item.model } };
    case "webSearch":
      return { toolName: "web_search", input: { query: item.query, action: item.action } };
    case "imageView":
      return { toolName: "view_image", input: { path: item.path } };
    case "imageGeneration":
      return { toolName: "image_generation", input: { prompt: item.revisedPrompt } };
    case "sleep":
      return { toolName: "sleep", input: { durationMs: item.durationMs } };
  }
};

const toolStarted = (item: ToolItem): EventPayload => ({
  _tag: "ToolCallStarted",
  callId: item.id,
  ...toolCall(item),
});

const toolResult = (item: ToolItem): { readonly output: unknown; readonly isError: boolean } => {
  switch (item.type) {
    case "commandExecution":
      return {
        output: { output: item.aggregatedOutput, exitCode: item.exitCode },
        isError: item.status !== "completed" || (item.exitCode ?? 0) !== 0,
      };
    case "fileChange":
      return { output: { status: item.status }, isError: item.status !== "completed" };
    case "mcpToolCall":
      return { output: item.error ?? item.result, isError: item.status !== "completed" };
    case "dynamicToolCall":
      return { output: item.contentItems, isError: item.status !== "completed" || item.success === false };
    case "collabAgentToolCall":
      return { output: item.agentsStates, isError: item.status === "failed" };
    case "webSearch":
      return { output: item.results ?? item.action, isError: false };
    case "imageView":
      return { output: { path: item.path }, isError: false };
    case "imageGeneration":
      // The image itself (`result`) is base64 data; the saved path identifies it.
      return { output: { savedPath: item.savedPath, failure: item.failure }, isError: item.failure !== null };
    case "sleep":
      return { output: null, isError: false };
  }
};

const toolCompleted = (item: ToolItem): EventPayload => ({
  _tag: "ToolCallCompleted",
  callId: item.id,
  ...toolResult(item),
});

const fileChanges = (item: ToolItem): ReadonlyArray<EventPayload> => {
  if (item.type !== "fileChange" || item.status !== "completed") return [];
  return item.changes.flatMap((change): ReadonlyArray<EventPayload> => {
    switch (change.kind.type) {
      case "add":
        return [{ _tag: "FileChanged", path: change.path, change: "created" }];
      case "delete":
        return [{ _tag: "FileChanged", path: change.path, change: "deleted" }];
      case "update":
        return change.kind.move_path
          ? [
              { _tag: "FileChanged", path: change.path, change: "deleted" },
              { _tag: "FileChanged", path: change.kind.move_path, change: "created" },
            ]
          : [{ _tag: "FileChanged", path: change.path, change: "modified" }];
    }
  });
};
