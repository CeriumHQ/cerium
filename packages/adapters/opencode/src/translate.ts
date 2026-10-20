import type { AdapterEvent } from "@cerium/harness";
import type { EventPayload, ReasoningEffort } from "@cerium/protocol";
import type { OpenCodeEvent } from "@opencode/client";

import { LOGIN_COMMAND } from "./manifest.ts";
import { permissionSummary } from "./policy.ts";

/** What the session feeds the translator: the server's events for its session, and its own turns. */
export type OpenCodeRecord =
  /** The session was created or resumed. */
  | {
      readonly type: "opened";
      readonly sessionId: string;
      readonly model: string;
      readonly effort?: ReasoningEffort | undefined;
    }
  /** One event of this session from the server's stream. */
  | { readonly type: "event"; readonly event: OpenCodeEvent }
  /** `session.prompt` failed, so the turn never ran. */
  | { readonly type: "promptFailed"; readonly message: string }
  /** The turn was interrupted before its prompt was sent. */
  | { readonly type: "promptSkipped" };

type Event<T extends OpenCodeEvent["type"]> = Extract<OpenCodeEvent, { type: T }>;
type ToolEnd = Event<"session.tool.success"> | Event<"session.tool.failed">;
type StructuredError = Event<"session.execution.failed">["data"]["error"];
type Tokens = NonNullable<Event<"session.step.failed">["data"]["tokens"]>;

/** A permission request as the server asked it. */
export type PermissionAsk = Event<"permission.asked">["data"];

interface ToolCall {
  readonly name: string;
  input?: unknown;
  started: boolean;
}

interface Usage {
  input: number;
  output: number;
  cached: number;
  cost: number;
}

export interface TranslatorOptions {
  /** OpenCode's tool name as Cerium reports it (see `toolNamer`). */
  readonly toolName?: (name: string) => string;
}

/**
 * Translates one OpenCode session's events into canonical events. A Cerium turn is one execution:
 * it ends at `session.execution.succeeded`, `failed` or `interrupted`. Text and reasoning arrive as
 * numbered parts of each assistant message, so a part's deltas and its completion share
 * `<message>:<n>` (reasoning: `<message>:reasoning:<n>`).
 */
export class OpenCodeTranslator {
  readonly #toolName: (name: string) => string;
  #started = false;
  /** Text and reasoning parts still streaming, by message id, with what they said so far. */
  readonly #parts = new Map<string, string>();
  /** Tool calls this turn, by call id, until they complete. */
  readonly #tools = new Map<string, ToolCall>();
  /** Permission requests asked and not yet answered, by request id. */
  readonly #asks = new Map<string, PermissionAsk>();
  #usage: Usage | undefined;

  constructor(options: TranslatorOptions = {}) {
    this.#toolName = options.toolName ?? ((name) => name);
  }

  translate(record: OpenCodeRecord): ReadonlyArray<AdapterEvent> {
    const raw = record.type === "event" ? record.event : record;
    return this.#payloads(record).map((payload) => ({ payload, raw }));
  }

  /** An open permission request, for answering it. */
  ask(requestId: string): PermissionAsk | undefined {
    return this.#asks.get(requestId);
  }

  /** Closes a permission request with Cerium's answer. */
  resolved(
    requestId: string,
    outcome: { readonly decision: "allow" | "deny"; readonly scope: "once" | "session" },
    raw?: unknown,
  ): ReadonlyArray<AdapterEvent> {
    if (!this.#asks.delete(requestId)) return [];
    return [{ payload: { _tag: "PermissionResolved", requestId, ...outcome }, raw }];
  }

  #payloads(record: OpenCodeRecord): ReadonlyArray<EventPayload> {
    switch (record.type) {
      case "opened":
        if (this.#started) return [];
        this.#started = true;
        return [
          {
            _tag: "SessionStarted",
            provider: "opencode",
            providerSessionId: record.sessionId,
            model: record.model,
            ...(record.effort === undefined ? {} : { effort: record.effort }),
          },
        ];
      case "promptFailed":
        return this.#endTurn("error", { type: "prompt", message: record.message });
      case "promptSkipped":
        return this.#endTurn("interrupted", undefined);
      case "event":
        return this.#event(record.event);
    }
  }

  #event(event: OpenCodeEvent): ReadonlyArray<EventPayload> {
    switch (event.type) {
      case "session.text.delta":
        return this.#delta("MessageDelta", textId(event.data), event.data.delta);
      case "session.text.ended":
        return this.#completed("MessageCompleted", textId(event.data), event.data.text);
      case "session.reasoning.delta":
        return this.#delta("ReasoningDelta", reasoningId(event.data), event.data.delta);
      case "session.reasoning.ended":
        return this.#completed("ReasoningCompleted", reasoningId(event.data), event.data.text);
      case "session.tool.input.started":
        if (!this.#tools.has(event.data.id)) {
          this.#tools.set(event.data.id, { name: this.#toolName(event.data.name), started: false });
        }
        return [];
      case "session.tool.called": {
        const call = this.#tools.get(event.data.id);
        if (call === undefined) return [];
        call.input = event.data.input;
        return this.#start(event.data.id, call);
      }
      case "session.tool.success":
      case "session.tool.failed":
        return this.#completeTool(event);
      case "session.step.ended":
        this.#addUsage(event.data.tokens, event.data.cost);
        return [];
      case "session.step.failed":
        if (event.data.tokens !== undefined) this.#addUsage(event.data.tokens, event.data.cost ?? 0);
        return [];
      case "session.execution.succeeded":
        return this.#endTurn("completed", undefined);
      case "session.execution.interrupted":
        return this.#endTurn("interrupted", undefined);
      case "session.execution.failed": {
        const error = event.data.error;
        // Interrupting aborts the step, and denying a permission without a word stops the turn.
        return error.type === "aborted" || error.type === "permission.rejected"
          ? this.#endTurn("interrupted", undefined)
          : this.#endTurn("error", error);
      }
      case "permission.asked":
        return this.#asked(event.data);
      case "permission.replied":
        // Rejecting one request rejects the session's others, and ending a turn withdraws its own.
        if (!this.#asks.delete(event.data.requestID)) return [];
        return [
          {
            _tag: "PermissionResolved",
            requestId: event.data.requestID,
            decision: event.data.reply === "reject" ? "deny" : "allow",
            scope: "once",
          },
        ];
      default:
        // Inbox, step boundaries, usage totals, titles and instructions carry nothing canonical.
        return [];
    }
  }

  #delta(
    tag: "MessageDelta" | "ReasoningDelta",
    messageId: string,
    text: string,
  ): ReadonlyArray<EventPayload> {
    this.#parts.set(messageId, (this.#parts.get(messageId) ?? "") + text);
    return text === "" ? [] : [{ _tag: tag, messageId, text }];
  }

  #completed(
    tag: "MessageCompleted" | "ReasoningCompleted",
    messageId: string,
    text: string,
  ): ReadonlyArray<EventPayload> {
    this.#parts.delete(messageId);
    return text.trim() === "" ? [] : [{ _tag: tag, messageId, text }];
  }

  #start(callId: string, call: ToolCall): ReadonlyArray<EventPayload> {
    if (call.started) return [];
    call.started = true;
    return [{ _tag: "ToolCallStarted", callId, toolName: call.name, input: call.input ?? {} }];
  }

  #completeTool(event: ToolEnd): ReadonlyArray<EventPayload> {
    const { id: callId } = event.data;
    const call = this.#tools.get(callId);
    // A call whose input never parsed has no `tool.called`; its end still makes a pair.
    if (call === undefined) return [];
    const started = this.#start(callId, call);
    this.#tools.delete(callId);
    const metadata = event.data.metadata;
    const exitCode = numberOf(metadata?.["exit"]);
    const completed: EventPayload =
      event.type === "session.tool.success"
        ? {
            _tag: "ToolCallCompleted",
            callId,
            output: toolOutput(event.data.content, exitCode),
            isError: exitCode !== undefined && exitCode !== 0,
          }
        : {
            _tag: "ToolCallCompleted",
            callId,
            output: failureOutput(event.data.error.message, event.data.content),
            isError: true,
          };
    const changed = event.type === "session.tool.success" ? fileChanges(call, event) : [];
    return [...started, completed, ...changed];
  }

  #asked(ask: PermissionAsk): ReadonlyArray<EventPayload> {
    this.#asks.set(ask.id, ask);
    const call = ask.source === undefined ? undefined : this.#tools.get(ask.source.id);
    return [
      {
        _tag: "PermissionRequested",
        requestId: ask.id,
        toolName: call?.name ?? ask.action,
        summary: permissionSummary(ask),
        input: permissionInput(ask, call),
      },
    ];
  }

  #addUsage(tokens: Tokens, cost: number) {
    const usage = (this.#usage ??= { input: 0, output: 0, cached: 0, cost: 0 });
    // Input excludes cache reads; cache writes are new input, as with Claude. Reasoning is output.
    usage.input += tokens.input + tokens.cache.write;
    usage.output += tokens.output + tokens.reasoning;
    usage.cached += tokens.cache.read;
    usage.cost += cost;
  }

  #endTurn(
    reason: "completed" | "interrupted" | "error",
    error: StructuredError | undefined,
  ): ReadonlyArray<EventPayload> {
    const payloads: Array<EventPayload> = [];
    // Parts the server never ended (an aborted step) end with what they said.
    for (const [messageId, text] of this.#parts) {
      if (text.trim() === "") continue;
      payloads.push({
        _tag: messageId.includes(":reasoning:") ? "ReasoningCompleted" : "MessageCompleted",
        messageId,
        text,
      });
    }
    this.#parts.clear();
    for (const [callId, call] of this.#tools) {
      if (!call.started) continue;
      payloads.push({
        _tag: "ToolCallCompleted",
        callId,
        output: "The turn ended before this tool call finished.",
        isError: true,
      });
    }
    this.#tools.clear();
    for (const requestId of this.#asks.keys()) {
      payloads.push({ _tag: "PermissionResolved", requestId, decision: "deny", scope: "once" });
    }
    this.#asks.clear();
    const usage = this.#usage;
    this.#usage = undefined;
    if (usage !== undefined) payloads.push(usagePayload(usage));
    if (error !== undefined) payloads.push(errorPayload(error));
    payloads.push({ _tag: "TurnCompleted", stopReason: reason });
    return payloads;
  }
}

const textId = (part: { readonly assistantMessageID: string; readonly ordinal: number }) =>
  `${part.assistantMessageID}:${part.ordinal}`;

const reasoningId = (part: { readonly assistantMessageID: string; readonly ordinal: number }) =>
  `${part.assistantMessageID}:reasoning:${part.ordinal}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const numberOf = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const stringOf = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

type Content = ToolEnd["data"]["content"];

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

/**
 * A tool's content as the transcript reads it: its text, a command's text with its exit code, or
 * content items with images inline, as MCP carries them.
 */
const toolOutput = (content: NonNullable<Content>, exitCode: number | undefined): unknown => {
  const text = content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
  if (exitCode !== undefined) return { output: text, exitCode };
  if (content.every((item) => item.type === "text")) return text;
  return content.map((item) => {
    if (item.type === "text") return item;
    const inline = DATA_URL.exec(item.uri);
    return inline === null
      ? { type: "text", text: item.name ?? item.uri }
      : { type: "image", mimeType: item.mime || inline[1], data: inline[2] };
  });
};

const failureOutput = (message: string, content: Content | undefined): string => {
  const text = content?.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n") ?? "";
  return text === "" || text === message ? message : `${message}\n${text}`;
};

/** The files a call changed: an edit's and a patch's from their metadata, a write's from its input. */
const fileChanges = (call: ToolCall, event: Event<"session.tool.success">): ReadonlyArray<EventPayload> => {
  const files = event.data.metadata?.["files"];
  if (Array.isArray(files)) {
    return files.flatMap((file): ReadonlyArray<EventPayload> => {
      const path = isRecord(file) ? stringOf(file["file"]) : undefined;
      if (path === undefined) return [];
      const status = isRecord(file) ? file["status"] : undefined;
      const change = status === "added" ? "created" : status === "deleted" ? "deleted" : "modified";
      return [{ _tag: "FileChanged", path, change }];
    });
  }
  const path = isRecord(call.input) ? stringOf(call.input["path"]) : undefined;
  if (call.name !== "write" || path === undefined) return [];
  const created = event.data.content.some((item) => item.type === "text" && item.text.startsWith("Created"));
  return [{ _tag: "FileChanged", path, change: created ? "created" : "modified" }];
};

/**
 * What a permission request shows: an edit's patches as the approval card draws them, else the tool
 * call's own input, else what the request names.
 */
const permissionInput = (ask: PermissionAsk, call: ToolCall | undefined): unknown => {
  const files = ask.metadata?.["files"];
  if (Array.isArray(files)) {
    const changes = files.flatMap((file) => {
      if (!isRecord(file)) return [];
      const path = stringOf(file["file"]);
      const diff = stringOf(file["patch"]);
      if (path === undefined || diff === undefined) return [];
      const type = file["status"] === "added" ? "add" : file["status"] === "deleted" ? "delete" : "update";
      return [{ path, diff, kind: { type } }];
    });
    if (changes.length > 0) return { changes };
  }
  if (call?.input !== undefined) return call.input;
  return { action: ask.action, resources: ask.resources };
};

const count = (value: number) => Math.max(0, Math.round(value));

const usagePayload = (usage: Usage): EventPayload => ({
  _tag: "UsageReported",
  inputTokens: count(usage.input),
  outputTokens: count(usage.output),
  cachedInputTokens: count(usage.cached),
  // Free models and subscriptions cost nothing per token; only a real price is reported.
  ...(usage.cost > 0 ? { costUsd: usage.cost } : {}),
});

/** OpenCode's error types (`provider.auth`, `provider.rate-limit`, …) as canonical errors. */
export const errorPayload = (error: Pick<StructuredError, "type" | "message">): EventPayload => {
  switch (error.type) {
    case "provider.auth":
      return {
        _tag: "AuthRequired",
        provider: "opencode",
        reason: error.message,
        loginCommand: LOGIN_COMMAND,
      };
    case "provider.rate-limit":
      return { _tag: "AgentError", kind: "rateLimit", message: error.message, retryable: true };
    case "provider.quota":
      return { _tag: "AgentError", kind: "rateLimit", message: error.message, retryable: false };
    case "provider.transport":
    case "provider.timeout":
    case "provider.internal":
      return { _tag: "AgentError", kind: "transient", message: error.message, retryable: true };
    default:
      return { _tag: "AgentError", kind: "unknown", message: error.message, retryable: false };
  }
};
