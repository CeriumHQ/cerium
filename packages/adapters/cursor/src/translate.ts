import type { InteractionUpdate, ModelSelection, RunResult, TokenUsage } from "@cursor/sdk";
import type { AdapterEvent } from "@cerium/harness";
import type { EventPayload } from "@cerium/protocol";

import { CursorTodos } from "./todos.ts";

/** A failure the SDK reported: a thrown error (classified by the session) or a run's terminal error. */
export interface CursorError {
  readonly message: string;
  readonly code?: string;
  /** Set from the SDK error class when one was thrown; run errors carry only a message. */
  readonly kind?: "auth" | "rateLimit" | "network" | "other";
  readonly isRetryable?: boolean;
}

/**
 * What the session feeds the translator. Turns are keyed by a Cerium id because `onDelta` updates can
 * arrive before `agent.send()` resolves with the run.
 */
export type CursorRecord =
  /** The agent was created or resumed; the SDK's local stream has no init message of its own. */
  | { readonly type: "agent"; readonly agentId: string; readonly model: ModelSelection }
  /** One `onDelta` update of a turn. */
  | { readonly type: "update"; readonly turn: string; readonly update: InteractionUpdate }
  /** `run.wait()`: how the turn ended. */
  | { readonly type: "result"; readonly turn: string; readonly result: RunResult }
  /**
   * The model finished the turn (its `turn-ended` update) but the run never settled: Cursor's service
   * would replay its turn, so the session cancelled it and ends the turn here.
   */
  | { readonly type: "turnEnded"; readonly turn: string }
  /** `agent.send()` or `run.wait()` rejected instead of returning a result. */
  | { readonly type: "sendFailed"; readonly turn: string; readonly error: CursorError };

/** Built-in tools whose success means a file changed, and how. Shell commands are not tracked. */
const FILE_TOOLS: Readonly<Record<string, "modified" | "deleted">> = {
  // The SDK reports new files as edits too (its `write` tool call is never streamed); both read as
  // "modified" because the result does not say whether the file existed.
  edit: "modified",
  write: "modified",
  delete: "deleted",
};

/**
 * Translates one Cursor session's SDK records into canonical events.
 *
 * The SDK streams text and reasoning as bare deltas with no block boundaries, so the translator cuts
 * segments itself: a segment ends when the other kind starts, at a tool call, at the end of a model
 * step and at the end of the turn. A segment's deltas and its completion share `<turn>:<n>`.
 */
export class CursorTranslator {
  #started = false;
  #segments = 0;
  #text: { readonly id: string; text: string } | undefined;
  #reasoning: { readonly id: string; text: string } | undefined;
  /** Tool calls started this turn and not yet completed. */
  readonly #openTools = new Set<string>();
  /** The todo tools' calls, which report the agent's todo list instead of tool calls. */
  readonly #todos = new CursorTodos();
  /** Usage of the model turns inside this Cerium turn; a run can span several. */
  #usage: Tokens | undefined;

  translate(record: CursorRecord): ReadonlyArray<AdapterEvent> {
    const raw = rawOf(record);
    return this.#payloads(record).map((payload) => ({ payload, raw }));
  }

  #payloads(record: CursorRecord): ReadonlyArray<EventPayload> {
    switch (record.type) {
      case "agent":
        if (this.#started) return [];
        this.#started = true;
        return [
          {
            _tag: "SessionStarted",
            provider: "cursor",
            providerSessionId: record.agentId,
            model: record.model.id,
          },
        ];
      case "update":
        return this.#update(record.turn, record.update);
      case "result":
        return this.#endTurn(
          stopReason(record.result),
          record.result.status === "error"
            ? (record.result.error ?? { message: "The run failed" })
            : undefined,
          record.result.usage,
        );
      case "turnEnded":
        return this.#endTurn("completed", undefined, undefined);
      case "sendFailed":
        return this.#endTurn("error", record.error, undefined);
    }
  }

  #update(turn: string, update: InteractionUpdate): ReadonlyArray<EventPayload> {
    switch (update.type) {
      case "text-delta": {
        const closed = this.#closeReasoning();
        this.#text ??= { id: this.#segmentId(turn), text: "" };
        if (update.text === "") return closed;
        this.#text.text += update.text;
        return [...closed, { _tag: "MessageDelta", messageId: this.#text.id, text: update.text }];
      }
      case "thinking-delta": {
        const closed = this.#closeText();
        this.#reasoning ??= { id: this.#segmentId(turn), text: "" };
        if (update.text === "") return closed;
        this.#reasoning.text += update.text;
        return [...closed, { _tag: "ReasoningDelta", messageId: this.#reasoning.id, text: update.text }];
      }
      case "thinking-completed":
        return this.#closeReasoning();
      case "partial-tool-call":
      case "step-completed":
        return this.#closeSegments();
      case "tool-call-started":
        return [...this.#closeSegments(), ...this.#startTool(update.callId, update.toolCall)];
      case "tool-call-completed":
        return [...this.#closeSegments(), ...this.#completeTool(update.callId, update.toolCall)];
      case "turn-ended":
        if (update.usage !== undefined) this.#usage = addUsage(this.#usage, update.usage);
        return this.#closeSegments();
      default:
        // Subagent deltas (`tool-call-delta`), steps, token counts and summaries carry nothing canonical.
        return [];
    }
  }

  #startTool(callId: string, toolCall: unknown): ReadonlyArray<EventPayload> {
    if (this.#todos.isTodoTool(toolName(toolCall)) || this.#openTools.has(callId)) return [];
    this.#openTools.add(callId);
    return [{ _tag: "ToolCallStarted", callId, toolName: toolName(toolCall), input: toolInput(toolCall) }];
  }

  #completeTool(callId: string, toolCall: unknown): ReadonlyArray<EventPayload> {
    const name = toolName(toolCall);
    if (this.#todos.isTodoTool(name))
      return this.#todos.completed(callId, name, toolInput(toolCall), toolCall);
    // A completion can arrive without its start (the SDK drops some starts); emit both to keep pairs.
    const started = this.#startTool(callId, toolCall);
    this.#openTools.delete(callId);
    const result = field(toolCall, "result");
    const status = field(result, "status");
    const isError = status === "error" || reportsFailure(toolCall);
    const completed: EventPayload = {
      _tag: "ToolCallCompleted",
      callId,
      output:
        status === "success" ? field(result, "value") : status === "error" ? field(result, "error") : result,
      isError,
    };
    const change = FILE_TOOLS[String(field(toolCall, "type"))];
    const path = field(field(toolCall, "args"), "path");
    const changed: ReadonlyArray<EventPayload> =
      change !== undefined && status === "success" && typeof path === "string" && path !== ""
        ? [{ _tag: "FileChanged", path, change }]
        : [];
    return [...started, completed, ...changed];
  }

  #endTurn(
    reason: "completed" | "interrupted" | "error",
    error: CursorError | undefined,
    reportedUsage: Tokens | undefined,
  ): ReadonlyArray<EventPayload> {
    const payloads: Array<EventPayload> = [...this.#closeSegments()];
    for (const callId of this.#openTools) {
      payloads.push({
        _tag: "ToolCallCompleted",
        callId,
        output: "The turn ended before this tool call finished.",
        isError: true,
      });
    }
    this.#openTools.clear();
    const usage = this.#usage ?? reportedUsage;
    this.#usage = undefined;
    if (usage !== undefined) payloads.push(toUsagePayload(usage));
    if (error !== undefined) payloads.push(errorPayload(error));
    payloads.push({ _tag: "TurnCompleted", stopReason: reason });
    return payloads;
  }

  #segmentId(turn: string): string {
    return `${turn}:${this.#segments++}`;
  }

  #closeText(): ReadonlyArray<EventPayload> {
    const segment = this.#text;
    this.#text = undefined;
    return segment === undefined || segment.text === ""
      ? []
      : [{ _tag: "MessageCompleted", messageId: segment.id, text: segment.text }];
  }

  #closeReasoning(): ReadonlyArray<EventPayload> {
    const segment = this.#reasoning;
    this.#reasoning = undefined;
    return segment === undefined || segment.text === ""
      ? []
      : [{ _tag: "ReasoningCompleted", messageId: segment.id, text: segment.text }];
  }

  #closeSegments(): ReadonlyArray<EventPayload> {
    return [...this.#closeReasoning(), ...this.#closeText()];
  }
}

const rawOf = (record: CursorRecord): unknown => {
  switch (record.type) {
    case "update":
      return record.update;
    case "result":
      return record.result;
    case "sendFailed":
      return record.error;
    case "agent":
    case "turnEnded":
      return record;
  }
};

/** Tool calls are typed by the SDK but documented as unstable: read their fields defensively. */
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** Built-in tools keep Cursor's names; MCP calls use the `mcp__<server>__<tool>` form every adapter shares. */
const toolName = (toolCall: unknown): string => {
  const type = text(field(toolCall, "type"));
  if (type === "mcp") {
    const args = field(toolCall, "args");
    return `mcp__${text(field(args, "providerIdentifier")) ?? "unknown"}__${text(field(args, "toolName")) ?? "unknown"}`;
  }
  // Tool kinds the SDK does not model yet pass through as their raw `{ case, value }`.
  return type ?? text(field(toolCall, "case")) ?? "unknown";
};

const toolInput = (toolCall: unknown): unknown => {
  const args = field(toolCall, "args");
  return field(toolCall, "type") === "mcp"
    ? (field(args, "args") ?? {})
    : (args ?? field(toolCall, "value") ?? {});
};

/** Calls the SDK reports as successful although they failed: a non-zero exit, an MCP tool error. */
const reportsFailure = (toolCall: unknown): boolean => {
  const value = field(field(toolCall, "result"), "value");
  switch (field(toolCall, "type")) {
    case "shell": {
      const exitCode = field(value, "exitCode");
      return typeof exitCode === "number" && exitCode !== 0;
    }
    case "mcp":
      return field(value, "isError") === true;
    default:
      return false;
  }
};

/** The token counts of `TokenUsage` and of a `turn-ended` update. */
type Tokens = Pick<TokenUsage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">;

const addUsage = (total: Tokens | undefined, turn: Tokens): Tokens => ({
  inputTokens: (total?.inputTokens ?? 0) + turn.inputTokens,
  outputTokens: (total?.outputTokens ?? 0) + turn.outputTokens,
  cacheReadTokens: (total?.cacheReadTokens ?? 0) + turn.cacheReadTokens,
  cacheWriteTokens: (total?.cacheWriteTokens ?? 0) + turn.cacheWriteTokens,
});

const count = (value: number) => Math.max(0, Math.round(value));

/**
 * Cursor's four token counts are disjoint (the SDK totals them by plain addition). Cache writes are new
 * input, as with Claude; cache reads are reported separately.
 */
const toUsagePayload = (usage: Tokens): EventPayload => ({
  _tag: "UsageReported",
  inputTokens: count(usage.inputTokens + usage.cacheWriteTokens),
  outputTokens: count(usage.outputTokens),
  cachedInputTokens: count(usage.cacheReadTokens),
});

const stopReason = (result: RunResult) => {
  switch (result.status) {
    case "finished":
      return "completed";
    case "cancelled":
      return "interrupted";
    case "error":
      return "error";
  }
};

const AUTH = /unauthenticated|unauthori[sz]ed|api key|not logged in|authentication/i;
const RATE_LIMIT = /rate limit|usage limit|too many requests|resource.exhausted/i;
/** A rate limit that is the plan's usage running out, not a throttle that passes in seconds. */
const USAGE_LIMIT = /usage limit|out of usage|limit reached|exceeded your/i;
const NETWORK = /network|unavailable|timed? ?out|deadline|econn|socket|fetch failed/i;

/** Run errors carry only a message (e.g. "[unknown] Invalid User API Key"), so their kind is read from it. */
const errorKind = (error: CursorError): NonNullable<CursorError["kind"]> => {
  if (error.kind !== undefined && error.kind !== "other") return error.kind;
  const subject = `${error.code ?? ""} ${error.message}`;
  if (AUTH.test(subject)) return "auth";
  if (RATE_LIMIT.test(subject)) return "rateLimit";
  if (NETWORK.test(subject)) return "network";
  return "other";
};

const errorPayload = (error: CursorError): EventPayload => {
  switch (errorKind(error)) {
    case "auth":
      // No command to run: Cursor signs in from Settings → Harnesses (`CursorAdapter.login`).
      return { _tag: "AuthRequired", provider: "cursor", reason: error.message };
    case "rateLimit":
      // Throttled for a moment, or out of the plan's usage: only the latter pauses a thread.
      return USAGE_LIMIT.test(error.message)
        ? { _tag: "LimitReached", provider: "cursor", message: error.message }
        : { _tag: "AgentError", kind: "rateLimit", message: error.message, retryable: true };
    case "network":
      return { _tag: "AgentError", kind: "transient", message: error.message, retryable: true };
    case "other":
      return {
        _tag: "AgentError",
        kind: "unknown",
        message: error.message,
        retryable: error.isRetryable ?? false,
      };
  }
};
