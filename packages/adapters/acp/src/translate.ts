import type { AdapterEvent } from "@cerium/harness";
import type { EventPayload, ProviderId, ReasoningEffort, TodoItem } from "@cerium/protocol";
import { randomUUID } from "node:crypto";

import {
  textOf,
  type ContentBlock,
  type Meta,
  type PermissionRequest,
  type SessionUpdate,
  type ToolCall,
  type ToolCallContent,
} from "./schema.ts";

// Turns an ACP session's updates into Cerium's canonical events. Stateful per session: messages and
// thoughts stream as deltas and complete when something else starts or the turn ends, tool calls
// gather their updates by id, and the end of a turn settles whatever it left open.

/** A tool call as its updates have described it so far. */
export interface ToolCallState {
  readonly id: string;
  title?: string;
  name?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content: ReadonlyArray<ToolCallContent>;
  locations: ReadonlyArray<{ readonly path: string }>;
  meta?: Meta;
}

/** How Cerium shows a tool call: a name its transcript knows, and the input it reads. */
export interface ToolView {
  readonly name: string;
  readonly input: unknown;
}

/** One turn's usage, as the adapter read it. `inputTokens` leaves out cache reads. */
export interface TurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly costUsd?: number;
}

/** How a turn ended. */
export interface TurnEnd {
  readonly stopReason: "completed" | "interrupted" | "maxTurns" | "error";
  readonly usage?: TurnUsage;
  /** How full the context was on the turn's last request. */
  readonly context?: { readonly tokens: number; readonly window?: number };
  /** What went wrong, reported before the turn completes. */
  readonly error?: EventPayload;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (value: unknown, ...keys: ReadonlyArray<string>): string | undefined => {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const found = value[key];
    if (typeof found === "string" && found !== "") return found;
  }
  return undefined;
};

type Diff = Extract<ToolCallContent, { readonly type: "diff" }>;
const isDiff = (content: ToolCallContent): content is Diff => content.type === "diff";

/** The input fields Cerium's transcript reads an edit by, from the diffs a call carries. */
const editFields = (diffs: ReadonlyArray<Diff>): Record<string, unknown> => {
  if (diffs.length === 0) return {};
  if (diffs.length > 1) {
    return {
      edits: diffs.map((diff) => ({
        path: diff.path,
        old_string: diff.oldText ?? "",
        new_string: diff.newText,
      })),
    };
  }
  const [diff] = diffs;
  return diff!.oldText === undefined || diff!.oldText === null
    ? { content: diff!.newText }
    : { old_string: diff!.oldText, new_string: diff!.newText };
};

/** `extra`'s fields where `input` has none of its own. */
const withDefaults = (input: unknown, extra: Record<string, unknown>): unknown => {
  const base = isRecord(input) ? input : input === undefined ? {} : { input };
  const added = Object.fromEntries(Object.entries(extra).filter(([key]) => base[key] === undefined));
  return Object.keys(added).length === 0 ? base : { ...base, ...added };
};

/** Cerium's transcript names for ACP's tool kinds. */
const KIND_NAMES: Readonly<Record<string, string>> = {
  read: "Read",
  edit: "Edit",
  delete: "delete",
  search: "Grep",
  execute: "Bash",
  fetch: "WebFetch",
};

/**
 * A tool call as Cerium shows it when its agent says nothing more: named by its kind, with the path,
 * command and edits its transcript reads added to the agent's own input.
 */
export const defaultToolView = (call: ToolCallState): ToolView => {
  const diffs = call.content.filter(isDiff);
  const path =
    stringField(call.rawInput, "file_path", "path", "filePath") ?? call.locations[0]?.path ?? diffs[0]?.path;
  const created =
    diffs.length > 0 && diffs.every((diff) => diff.oldText === undefined || diff.oldText === null);
  const name =
    call.kind === "edit" && created
      ? "Write"
      : (KIND_NAMES[call.kind ?? ""] ?? call.name ?? call.title ?? call.kind ?? "tool");
  const command =
    call.kind === "execute" ? (stringField(call.rawInput, "command", "cmd") ?? call.title) : undefined;
  return {
    name,
    input: withDefaults(call.rawInput, {
      ...(path === undefined ? {} : { file_path: path }),
      ...(command === undefined ? {} : { command }),
      ...editFields(diffs),
      ...(call.title === undefined || call.title === command ? {} : { description: call.title }),
    }),
  };
};

/** What a finished tool call shows as its result. */
export const outputOf = (call: ToolCallState): unknown => {
  const text = call.content
    .flatMap((content) =>
      content.type === "content"
        ? [textOf([content.content])]
        : content.type === "diff"
          ? [content.path]
          : [],
    )
    .filter((line) => line !== "")
    .join("\n");
  if (text !== "") return text;
  if (call.rawOutput !== undefined && call.rawOutput !== null) return call.rawOutput;
  return "";
};

const TODO_STATUS: Readonly<Record<string, TodoItem["status"]>> = {
  pending: "pending",
  in_progress: "inProgress",
  completed: "completed",
};

export interface TranslatorOptions {
  readonly provider: ProviderId;
  /** Names each tool call; `defaultToolView` by default. */
  readonly view?: (call: ToolCallState) => ToolView;
  /** Ids for messages, thoughts and permission requests; random UUIDs by default. */
  readonly newId?: () => string;
}

interface Stream {
  readonly id: string;
  text: string;
  /** The agent's own id for the message, where it gives one. */
  readonly acpId?: string;
}

interface Ask {
  readonly callId: string;
  readonly toolName: string;
}

export class AcpTranslator {
  readonly #provider: ProviderId;
  readonly #view: (call: ToolCallState) => ToolView;
  readonly #newId: () => string;
  #message: Stream | undefined;
  #reasoning: Stream | undefined;
  readonly #calls = new Map<string, ToolCallState & { started: boolean; done: boolean }>();
  readonly #asks = new Map<string, Ask>();
  /** Calls the user or Cerium refused this turn. */
  readonly #denied = new Set<string>();
  /** The session's total cost as the agent last reported it, and what it was when the turn began. */
  #cost: number | undefined;
  #costAtTurnStart = 0;
  /** A compaction Cerium asked for is under way, and whether it has been reported. */
  #compacting = false;
  #compactedThisTurn = false;

  constructor(options: TranslatorOptions) {
    this.#provider = options.provider;
    this.#view = options.view ?? defaultToolView;
    this.#newId = options.newId ?? randomUUID;
  }

  newId(): string {
    return this.#newId();
  }

  opened(sessionId: string, model: string, effort?: ReasoningEffort): ReadonlyArray<AdapterEvent> {
    return [
      {
        payload: {
          _tag: "SessionStarted",
          provider: this.#provider,
          providerSessionId: sessionId,
          model,
          ...(effort === undefined ? {} : { effort }),
        },
      },
    ];
  }

  /** The compaction the next turn runs is one Cerium asked for. */
  compacting(): void {
    this.#compacting = true;
    this.#compactedThisTurn = false;
  }

  /** The compaction Cerium asked for is done; reported here unless the agent's own update did. */
  compacted(counts: {
    readonly tokensBefore?: number;
    readonly tokensAfter?: number;
    readonly summary?: string;
  }): ReadonlyArray<AdapterEvent> {
    if (this.#compactedThisTurn) return [];
    this.#compactedThisTurn = true;
    return [
      {
        payload: {
          _tag: "ContextCompacted",
          trigger: "manual",
          ...(counts.tokensBefore === undefined
            ? {}
            : { tokensBefore: Math.max(0, Math.round(counts.tokensBefore)) }),
          ...(counts.tokensAfter === undefined
            ? {}
            : { tokensAfter: Math.max(0, Math.round(counts.tokensAfter)) }),
          ...(counts.summary === undefined || counts.summary === "" ? {} : { summary: counts.summary }),
        },
      },
    ];
  }

  update(update: SessionUpdate, raw?: unknown): ReadonlyArray<AdapterEvent> {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return this.#text("message", update.content, update.messageId ?? undefined);
      case "agent_thought_chunk":
        return this.#text("reasoning", update.content, update.messageId ?? undefined);
      case "tool_call":
      case "tool_call_update":
        return this.#toolCall(update, raw);
      case "plan":
        return [
          {
            payload: {
              _tag: "TodosUpdated",
              items: update.entries.map((entry) => ({
                text: entry.content,
                status: TODO_STATUS[entry.status ?? ""] ?? "pending",
              })),
            },
            raw,
          },
        ];
      case "usage_update": {
        if (
          update.cost !== undefined &&
          update.cost !== null &&
          update.cost.currency.toUpperCase() === "USD"
        ) {
          this.#cost = update.cost.amount;
        }
        return [
          {
            payload: {
              _tag: "ContextReported",
              tokens: Math.max(0, Math.round(update.used)),
              ...(update.size >= 1 ? { window: Math.round(update.size) } : {}),
            },
          },
        ];
      }
      case "compaction_update": {
        if (update.status !== "completed") return [];
        const summary = textOf(update.summary ?? []);
        const trigger = this.#compacting ? "manual" : "auto";
        if (this.#compacting) this.#compactedThisTurn = true;
        return [
          { payload: { _tag: "ContextCompacted", trigger, ...(summary === "" ? {} : { summary }) }, raw },
        ];
      }
      case "notice":
        return update.severity === "error"
          ? [
              {
                payload: { _tag: "AgentError", kind: "unknown", message: update.title, retryable: false },
                raw,
              },
            ]
          : [];
      // The user's own messages are only replayed (`session/load`), which the history reads apart.
      case "user_message_chunk":
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
        return [];
    }
  }

  /** The tool call a permission request is about, as the session knows it now. */
  track(call: ToolCall): ToolCallState {
    return this.#merge(call);
  }

  view(call: ToolCallState): ToolView {
    return this.#view(call);
  }

  /** The agent asks the user to allow a tool call: the call shows first, then the request. */
  permission(requestId: string, request: PermissionRequest, summary?: string): ReadonlyArray<AdapterEvent> {
    const call = this.#merge(request.toolCall);
    const events = [...this.#closeText(), ...this.#start(call)];
    const view = this.#view(call);
    this.#asks.set(requestId, { callId: call.id, toolName: view.name });
    events.push({
      payload: {
        _tag: "PermissionRequested",
        requestId,
        toolName: view.name,
        summary: summary ?? call.title ?? view.name,
        input: view.input,
      },
      raw: request,
    });
    return events;
  }

  /** The user answered a permission request; nothing for one already settled. */
  resolved(
    requestId: string,
    decision: "allow" | "deny",
    scope: "once" | "session",
  ): ReadonlyArray<AdapterEvent> {
    const ask = this.#asks.get(requestId);
    if (ask === undefined) return [];
    this.#asks.delete(requestId);
    if (decision === "deny") this.#denied.add(ask.callId);
    return [{ payload: { _tag: "PermissionResolved", requestId, decision, scope } }];
  }

  /** A tool call Cerium refused without asking: it fails unless the agent says otherwise. */
  refused(callId: string): void {
    this.#denied.add(callId);
  }

  /** The requests still waiting on the user. */
  openAsks(): ReadonlyArray<string> {
    return [...this.#asks.keys()];
  }

  /**
   * Ends the turn: what it left open completes (an unfinished tool call as failed when the turn was
   * stopped), its usage and context follow, then exactly one `TurnCompleted`.
   */
  endTurn(end: TurnEnd): ReadonlyArray<AdapterEvent> {
    const events: Array<AdapterEvent> = [...this.#closeText()];
    for (const requestId of this.#asks.keys()) {
      events.push({ payload: { _tag: "PermissionResolved", requestId, decision: "deny", scope: "once" } });
    }
    this.#asks.clear();
    const stopped = end.stopReason !== "completed" && end.stopReason !== "maxTurns";
    for (const call of this.#calls.values()) {
      if (!call.started || call.done) continue;
      call.done = true;
      const denied = this.#denied.has(call.id);
      const output = outputOf(call);
      events.push({
        payload: {
          _tag: "ToolCallCompleted",
          callId: call.id,
          output: denied ? "Not allowed" : stopped && output === "" ? "Stopped before it finished" : output,
          isError: denied || stopped,
        },
      });
    }
    this.#calls.clear();
    this.#denied.clear();
    if (end.error !== undefined) events.push({ payload: end.error });
    if (end.usage !== undefined) {
      const turnCost =
        end.usage.costUsd ??
        (this.#cost === undefined ? undefined : Math.max(0, this.#cost - this.#costAtTurnStart));
      events.push({
        payload: {
          _tag: "UsageReported",
          inputTokens: Math.max(0, Math.round(end.usage.inputTokens)),
          outputTokens: Math.max(0, Math.round(end.usage.outputTokens)),
          ...(end.usage.cachedInputTokens === undefined
            ? {}
            : { cachedInputTokens: Math.max(0, Math.round(end.usage.cachedInputTokens)) }),
          ...(turnCost === undefined ? {} : { costUsd: turnCost }),
        },
      });
    }
    this.#costAtTurnStart = this.#cost ?? this.#costAtTurnStart;
    if (end.context !== undefined) {
      events.push({
        payload: {
          _tag: "ContextReported",
          tokens: Math.max(0, Math.round(end.context.tokens)),
          ...(end.context.window === undefined || end.context.window < 1
            ? {}
            : { window: Math.round(end.context.window) }),
        },
      });
    }
    events.push({ payload: { _tag: "TurnCompleted", stopReason: end.stopReason } });
    this.#compacting = false;
    return events;
  }

  #text(
    kind: "message" | "reasoning",
    content: ContentBlock,
    acpId: string | undefined,
  ): ReadonlyArray<AdapterEvent> {
    const text = textOf([content]);
    if (text === "") return [];
    const events: Array<AdapterEvent> = [];
    // A thought ends the message before it, and a message the thought before it.
    events.push(...(kind === "message" ? this.#closeReasoning() : this.#closeMessage()));
    const open = kind === "message" ? this.#message : this.#reasoning;
    if (open !== undefined && acpId !== undefined && open.acpId !== undefined && open.acpId !== acpId) {
      events.push(...(kind === "message" ? this.#closeMessage() : this.#closeReasoning()));
    }
    let stream = kind === "message" ? this.#message : this.#reasoning;
    if (stream === undefined) {
      stream = { id: this.#newId(), text: "", ...(acpId === undefined ? {} : { acpId }) };
      if (kind === "message") this.#message = stream;
      else this.#reasoning = stream;
    }
    stream.text += text;
    events.push({
      payload:
        kind === "message"
          ? { _tag: "MessageDelta", messageId: stream.id, text }
          : { _tag: "ReasoningDelta", messageId: stream.id, text },
    });
    return events;
  }

  #closeMessage(): ReadonlyArray<AdapterEvent> {
    const message = this.#message;
    this.#message = undefined;
    return message === undefined
      ? []
      : [{ payload: { _tag: "MessageCompleted", messageId: message.id, text: message.text } }];
  }

  #closeReasoning(): ReadonlyArray<AdapterEvent> {
    const reasoning = this.#reasoning;
    this.#reasoning = undefined;
    return reasoning === undefined
      ? []
      : [{ payload: { _tag: "ReasoningCompleted", messageId: reasoning.id, text: reasoning.text } }];
  }

  #closeText(): ReadonlyArray<AdapterEvent> {
    return [...this.#closeReasoning(), ...this.#closeMessage()];
  }

  #merge(update: ToolCall): ToolCallState & { started: boolean; done: boolean } {
    const known = this.#calls.get(update.toolCallId);
    const call = known ?? { id: update.toolCallId, content: [], locations: [], started: false, done: false };
    if (update.title !== undefined && update.title !== null) call.title = update.title;
    if (update.name !== undefined && update.name !== null) call.name = update.name;
    if (update.kind !== undefined && update.kind !== null) call.kind = update.kind;
    if (update.status !== undefined && update.status !== null) call.status = update.status;
    if (update.rawInput !== undefined && update.rawInput !== null) call.rawInput = update.rawInput;
    if (update.rawOutput !== undefined && update.rawOutput !== null) call.rawOutput = update.rawOutput;
    if (update.content !== undefined && update.content !== null) call.content = update.content;
    if (update.locations !== undefined && update.locations !== null) call.locations = update.locations;
    if (update._meta !== undefined && update._meta !== null) call.meta = { ...call.meta, ...update._meta };
    if (known === undefined) this.#calls.set(call.id, call);
    return call;
  }

  #start(call: ToolCallState & { started: boolean }, raw?: unknown): ReadonlyArray<AdapterEvent> {
    if (call.started) return [];
    call.started = true;
    const view = this.#view(call);
    return [
      { payload: { _tag: "ToolCallStarted", callId: call.id, toolName: view.name, input: view.input }, raw },
    ];
  }

  #toolCall(update: ToolCall, raw: unknown): ReadonlyArray<AdapterEvent> {
    const call = this.#merge(update);
    if (call.done) return [];
    const events = [...this.#closeText(), ...this.#start(call, raw)];
    if (call.status !== "completed" && call.status !== "failed") return events;
    call.done = true;
    const failed = call.status === "failed";
    if (!failed) events.push(...this.#changes(call));
    events.push({
      payload: { _tag: "ToolCallCompleted", callId: call.id, output: outputOf(call), isError: failed },
      raw,
    });
    return events;
  }

  /** The files a finished call changed, from its diffs, or its locations for a delete. */
  #changes(call: ToolCallState): ReadonlyArray<AdapterEvent> {
    if (call.kind === "delete") {
      return call.locations.map(({ path }) => ({
        payload: { _tag: "FileChanged", path, change: "deleted" },
      }));
    }
    const seen = new Set<string>();
    return call.content.filter(isDiff).flatMap((diff): ReadonlyArray<AdapterEvent> => {
      if (seen.has(diff.path)) return [];
      seen.add(diff.path);
      const created = diff.oldText === undefined || diff.oldText === null;
      return [
        { payload: { _tag: "FileChanged", path: diff.path, change: created ? "created" : "modified" } },
      ];
    });
  }
}
