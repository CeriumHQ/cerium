import type { AdapterEvent } from "@cerium/harness";
import { sameTodos, type EventPayload, type ReasoningEffort, type TodoItem } from "@cerium/protocol";
import type { TurnOutcome } from "@muse-code/sdk";
import type {
  Item,
  ItemDeltaParams,
  SessionTodoListChangedParams,
  SessionTokenUsageParams,
  TokenUsage,
  TurnCompletedParams,
  TurnStartedParams,
  TurnUnqueuedParams,
} from "@muse-code/sdk/dist/src/msp.js";
import { Predicate } from "effect";
import { isAbsolute, join } from "node:path";

import { LOGIN_COMMAND } from "./manifest.ts";

/** One MSP notification as it arrived on the wire. */
export interface WireNotification {
  readonly method: string;
  readonly params?: Record<string, unknown> | undefined;
}

type Payload<Tag extends EventPayload["_tag"]> = Extract<EventPayload, { _tag: Tag }>;

/** Muse's todo tool. Its calls are bookkeeping: the list comes from `session/todoListChanged`. */
const TODO_TOOLS: ReadonlySet<string> = new Set(["write_todos"]);

const TODO_STATUSES: Readonly<Record<string, TodoItem["status"]>> = {
  inProgress: "inProgress",
  completed: "completed",
  cancelled: "cancelled",
};

interface TurnUsage {
  input: number;
  output: number;
  cached: number;
  costUsd: number;
  priced: boolean;
  reported: boolean;
}

/**
 * Translates one Muse session's live MSP notifications into canonical events.
 *
 * Items carry a stable `itemId` across `item/started` → `item/delta` → `item/completed`, which becomes the
 * message id and the tool call id. Only turns Cerium submitted (`expectTurn`) end in `TurnCompleted`, so a
 * turn Muse starts on its own (a cron job firing) cannot end a turn the orchestrator is waiting on.
 * Session history replayed on open is never fed here.
 */
export class MuseTranslator {
  readonly #workspace: string;
  /** Turns Cerium submitted that have not ended; `true` once Muse launched them. */
  readonly #turns = new Map<string, boolean>();
  readonly #ended = new Set<string>();
  readonly #usage = new Map<string, TurnUsage>();
  /** The session's cumulative cost estimate so far; unknown for a resumed session until it moves. */
  #costSoFar: number | undefined;
  /** Each open item's kind, which its deltas need. */
  readonly #kinds = new Map<string, string>();
  /** Items whose completion was emitted, so a re-delivered `item/completed` adds nothing. */
  readonly #finished = new Set<string>();
  /** Open tool calls whose start was emitted. */
  readonly #startedTools = new Set<string>();
  /** `item/delta` frames that arrived before their item, waiting to learn its kind. */
  readonly #earlyDeltas = new Map<string, Array<ItemDeltaParams>>();
  /** The summary part each open reasoning item streams. */
  readonly #reasoningPart = new Map<string, number>();
  #todos: ReadonlyArray<TodoItem> = [];
  /** The context window of the model the session runs, from its catalog row. */
  #window: number | undefined;
  /**
   * Cerium asked Muse to compact (`session/compact`), which runs outside any turn: the compaction's
   * terminal item ends the turn Cerium counts it as.
   */
  #compactAsked = false;

  constructor(options: { readonly workspace: string; readonly resumed?: boolean }) {
    this.#workspace = options.workspace;
    this.#costSoFar = options.resumed ? undefined : 0;
  }

  started(providerSessionId: string, model: string, effort?: ReasoningEffort): AdapterEvent {
    return {
      payload: {
        _tag: "SessionStarted",
        provider: "muse",
        providerSessionId,
        model,
        ...(effort ? { effort } : {}),
      },
      raw: { sessionId: providerSessionId, model, effort },
    };
  }

  /** Registers a turn Cerium is submitting, before its `turn/start` is sent. */
  expectTurn(turnId: string): void {
    this.#turns.set(turnId, false);
  }

  /** The ack named another turn than the pre-minted id (Muse only does so when input steers a turn). */
  renameTurn(from: string, to: string): void {
    const launched = this.#turns.get(from);
    if (launched === undefined || from === to) return;
    this.#turns.delete(from);
    if (!this.#ended.has(to)) this.#turns.set(to, this.#turns.get(to) ?? launched);
  }

  /** The submitted turns still open, with whether Muse has launched each one. */
  get openTurns(): ReadonlyArray<{ readonly turnId: string; readonly launched: boolean }> {
    return [...this.#turns].map(([turnId, launched]) => ({ turnId, launched }));
  }

  translate(notification: WireNotification): ReadonlyArray<AdapterEvent> {
    return this.#payloads(notification).map((payload) => ({ payload, raw: notification }));
  }

  /** Ends a submitted turn that will get no `turn/completed` on this feed (refused, reclaimed, lost). */
  endTurn(
    turnId: string,
    stopReason: Payload<"TurnCompleted">["stopReason"],
    raw: unknown,
    error?: Payload<"AgentError">,
  ): ReadonlyArray<AdapterEvent> {
    if (!this.#turns.has(turnId) || this.#ended.has(turnId)) return [];
    this.#turns.delete(turnId);
    this.#ended.add(turnId);
    const payloads: Array<EventPayload> = [
      ...(error ? [error] : []),
      usageReported(this.#takeUsage(turnId)),
      { _tag: "TurnCompleted", stopReason },
    ];
    return payloads.map((payload) => ({ payload, raw }));
  }

  /** Ends every submitted turn after the host went away. */
  endOpenTurns(message: string, raw: unknown): ReadonlyArray<AdapterEvent> {
    const compaction = this.#compactAsked ? this.compactRefused(message, raw) : [];
    return [
      ...compaction,
      ...[...this.#turns.keys()].flatMap((turnId) =>
        this.endTurn(turnId, "error", raw, { _tag: "AgentError", kind: "crash", message, retryable: true }),
      ),
    ];
  }

  /** The context window of the model the session runs now, when its catalog row declares one. */
  window(limit: number | undefined): void {
    this.#window = limit === undefined || limit < 1 ? undefined : Math.round(limit);
  }

  /** Cerium is asking Muse to compact: the compaction's end ends a turn. */
  compactAsked(): void {
    this.#compactAsked = true;
  }

  /** Muse refused to compact, or found nothing to: the turn ends with why. */
  compactRefused(message: string, raw: unknown): ReadonlyArray<AdapterEvent> {
    if (!this.#compactAsked) return [];
    this.#compactAsked = false;
    const payloads: ReadonlyArray<EventPayload> = [
      { _tag: "AgentError", kind: "unknown", message, retryable: false },
      { _tag: "TurnCompleted", stopReason: "error" },
    ];
    return payloads.map((payload) => ({ payload, raw }));
  }

  /**
   * The SDK's own turn-wait settled. It folds pages fetched after a delivery gap, so it can know a terminal
   * this feed never carried; anything the feed already ended adds nothing.
   */
  settled(turnId: string, outcome: TurnOutcome): ReadonlyArray<AdapterEvent> {
    if (!this.#turns.has(turnId)) return [];
    switch (outcome.kind) {
      case "completed":
        return this.translate({ method: "turn/completed", params: { ...outcome.params } });
      case "unqueued":
        return this.endTurn(turnId, "interrupted", outcome);
      case "terminalUnknown":
        return this.endTurn(turnId, "error", outcome, {
          _tag: "AgentError",
          kind: "crash",
          message: "Muse Code ended without finishing the turn",
          retryable: true,
        });
    }
  }

  #payloads(notification: WireNotification): ReadonlyArray<EventPayload> {
    const params = notification.params;
    if (params === undefined) return [];
    switch (notification.method) {
      case "item/started":
        return this.#item(params["item"] as Item, "started");
      case "item/updated":
        return this.#item(params["item"] as Item, "updated");
      case "item/completed":
        return this.#item(params["item"] as Item, "completed");
      case "item/delta":
        return this.#delta(params as unknown as ItemDeltaParams);
      case "session/tokenUsage": {
        const usage = params as unknown as SessionTokenUsageParams;
        this.#tokenUsage(usage);
        // The completion's whole context, counted once: what it read and what it wrote.
        const total = Number.isFinite(usage.totalTokens)
          ? usage.totalTokens
          : usage.promptTokens + usage.usage.outputTokens;
        const tokens = Math.max(0, Math.round(total));
        return [
          {
            _tag: "ContextReported",
            tokens,
            ...(this.#window === undefined ? {} : { window: this.#window }),
          },
        ];
      }
      case "session/todoListChanged":
        return this.#todoList(params as unknown as SessionTodoListChangedParams);
      case "turn/started": {
        const { turnId } = params as unknown as TurnStartedParams;
        if (this.#turns.has(turnId)) this.#turns.set(turnId, true);
        return [];
      }
      case "turn/completed":
        return this.#turnCompleted(params as unknown as TurnCompletedParams);
      case "turn/unqueued": {
        const { turnId } = params as unknown as TurnUnqueuedParams;
        return this.endTurn(turnId, "interrupted", notification).map((event) => event.payload);
      }
      default:
        return [];
    }
  }

  #item(item: Item, phase: "started" | "updated" | "completed"): ReadonlyArray<EventPayload> {
    const id = item.itemId;
    // A finished item's later events (a re-delivered `item/completed`) add nothing and its deltas are
    // dropped, so nothing is kept of it but that it finished.
    if (this.#finished.has(id)) return [];
    const finishing = phase === "completed";
    if (finishing) {
      this.#finished.add(id);
      this.#kinds.delete(id);
      this.#earlyDeltas.delete(id);
      this.#reasoningPart.delete(id);
    } else {
      this.#kinds.set(id, item.kind);
    }
    const early = finishing ? [] : this.#flushEarlyDeltas(id);

    switch (item.kind) {
      case "agentMessage":
        return finishing ? [{ _tag: "MessageCompleted", messageId: id, text: item.text ?? "" }] : early;
      case "reasoning": {
        if (!finishing) return early;
        const text = (item.summary ?? []).filter((part) => part !== "").join("\n\n") || (item.text ?? "");
        return text === "" ? [] : [{ _tag: "ReasoningCompleted", messageId: id, text }];
      }
      case "toolCall":
      case "webSearch": {
        if (item.tool !== undefined && TODO_TOOLS.has(item.tool)) {
          // The list arrives as its own notification; only a call that failed has anything to say.
          return finishing && item.status !== "completed"
            ? [
                { _tag: "ToolCallStarted", callId: id, toolName: item.tool, input: parseArgs(item.args) },
                {
                  _tag: "ToolCallCompleted",
                  callId: id,
                  output: item.visibleOutput ?? item.failureReason ?? item.fallbackText ?? null,
                  isError: true,
                },
              ]
            : [];
        }
        const payloads: Array<EventPayload> = [];
        if (!this.#startedTools.has(id)) {
          this.#startedTools.add(id);
          payloads.push({
            _tag: "ToolCallStarted",
            callId: id,
            toolName: item.tool ?? (item.kind === "webSearch" ? "web_search" : item.kind),
            input: parseArgs(item.args),
          });
        }
        if (finishing) {
          this.#startedTools.delete(id);
          const succeeded = item.status === "completed";
          payloads.push({
            _tag: "ToolCallCompleted",
            callId: id,
            output: item.visibleOutput ?? item.failureReason ?? item.fallbackText ?? null,
            isError: !succeeded,
          });
          if (succeeded) payloads.push(...fileChanges(item, this.#workspace));
        }
        return payloads;
      }
      case "compaction":
        return finishing ? this.#compaction(item) : [];
      default:
        // Subagent, reminder, hook and other items have no canonical event yet; `raw` in the store still
        // has them.
        return [];
    }
  }

  /** A compaction's terminal item; one Cerium asked for ends its turn. */
  #compaction(item: Item): ReadonlyArray<EventPayload> {
    const asked = this.#compactAsked;
    this.#compactAsked = false;
    const count = (value: number | undefined) =>
      value === undefined ? undefined : Math.max(0, Math.round(value));
    const before = count(item.tokensBefore);
    const after = count(item.tokensAfter);
    const summary = item.text?.trim();
    const outcome = item.outcome ?? "compacted";
    const payloads: Array<EventPayload> =
      outcome === "compacted"
        ? [
            {
              _tag: "ContextCompacted",
              trigger: item.trigger === "manual" || (item.trigger === undefined && asked) ? "manual" : "auto",
              ...(before === undefined ? {} : { tokensBefore: before }),
              ...(after === undefined ? {} : { tokensAfter: after }),
              ...(summary ? { summary } : {}),
            },
          ]
        : [
            {
              _tag: "AgentError",
              kind: "unknown",
              message:
                outcome === "noop"
                  ? `Muse Code found nothing to compact${item.reason ? ` (${item.reason})` : ""}.`
                  : `Muse Code couldn't compact the conversation (${item.reason ?? outcome}).`,
              retryable: false,
            },
          ];
    if (asked) {
      payloads.push({ _tag: "TurnCompleted", stopReason: outcome === "compacted" ? "completed" : "error" });
    }
    return payloads;
  }

  /** Muse sends the whole list at every change, and an empty one when it clears it. */
  #todoList(params: SessionTodoListChangedParams): ReadonlyArray<EventPayload> {
    const items = params.items.flatMap((each): ReadonlyArray<TodoItem> =>
      each.text === ""
        ? []
        : [
            {
              text: each.text,
              status: TODO_STATUSES[each.status] ?? "pending",
              ...(each.activeForm ? { activeText: each.activeForm } : {}),
            },
          ],
    );
    if (sameTodos(this.#todos, items)) return [];
    this.#todos = items;
    return [{ _tag: "TodosUpdated", items }];
  }

  #flushEarlyDeltas(itemId: string): ReadonlyArray<EventPayload> {
    const early = this.#earlyDeltas.get(itemId);
    if (early === undefined) return [];
    this.#earlyDeltas.delete(itemId);
    return early.flatMap((delta) => this.#delta(delta));
  }

  #delta(delta: ItemDeltaParams): ReadonlyArray<EventPayload> {
    if (this.#finished.has(delta.itemId)) return [];
    const kind = this.#kinds.get(delta.itemId);
    if (kind === undefined) {
      this.#earlyDeltas.set(delta.itemId, [...(this.#earlyDeltas.get(delta.itemId) ?? []), delta]);
      return [];
    }
    const field = delta.field ?? "text";
    if (kind === "agentMessage" && field === "text") {
      return delta.delta === "" ? [] : [{ _tag: "MessageDelta", messageId: delta.itemId, text: delta.delta }];
    }
    if (kind === "reasoning" && field.startsWith("summary.")) {
      // Each summary part streams under `summary.<n>`; parts are joined by a blank line, as on completion.
      const part = Number(field.slice("summary.".length));
      const previous = this.#reasoningPart.get(delta.itemId);
      this.#reasoningPart.set(delta.itemId, part);
      const text = (previous !== undefined && previous !== part ? "\n\n" : "") + delta.delta;
      return text === "" ? [] : [{ _tag: "ReasoningDelta", messageId: delta.itemId, text }];
    }
    return [];
  }

  #usageOf(turnId: string): TurnUsage {
    const existing = this.#usage.get(turnId);
    if (existing !== undefined) return existing;
    const usage: TurnUsage = { input: 0, output: 0, cached: 0, costUsd: 0, priced: false, reported: false };
    this.#usage.set(turnId, usage);
    return usage;
  }

  /**
   * One model call's usage. `promptTokens` is counted once under the provider's cache convention, so the
   * uncached input is what remains after cache reads. Cost is the change in the session's cumulative
   * estimate.
   */
  #tokenUsage(params: SessionTokenUsageParams): void {
    const usage = this.#usageOf(params.turnId);
    const cacheRead = cacheReads(params.usage);
    usage.input += Math.max(0, params.promptTokens - cacheRead);
    usage.cached += cacheRead;
    usage.output += params.usage.outputTokens;
    usage.reported = true;
    const total = params.cumulative.cost?.usd;
    if (total === undefined) return;
    if (this.#costSoFar !== undefined) {
      usage.costUsd += Math.max(0, total - this.#costSoFar);
      usage.priced = true;
    }
    this.#costSoFar = total;
  }

  /** The turn's usage; `turn/completed`'s aggregate stands in when no per-call usage arrived. */
  #takeUsage(turnId: string, aggregate?: TokenUsage): TurnUsage {
    const usage = this.#usageOf(turnId);
    this.#usage.delete(turnId);
    if (!usage.reported && aggregate !== undefined) {
      const cacheRead = cacheReads(aggregate);
      usage.input = Math.max(0, aggregate.inputTokens - cacheRead);
      usage.cached = cacheRead;
      usage.output = aggregate.outputTokens;
      usage.reported = true;
    }
    return usage;
  }

  #turnCompleted(params: TurnCompletedParams): ReadonlyArray<EventPayload> {
    if (this.#ended.has(params.turnId)) return [];
    const own = this.#turns.has(params.turnId);
    const usage = this.#takeUsage(params.turnId, params.usage);
    const payloads: Array<EventPayload> = [...turnErrors(params)];
    if (own || usage.reported) payloads.push(usageReported(usage));
    if (own) {
      this.#turns.delete(params.turnId);
      this.#ended.add(params.turnId);
      payloads.push({ _tag: "TurnCompleted", stopReason: stopReason(params) });
    }
    return payloads;
  }
}

const cacheReads = (usage: TokenUsage) => usage.cacheReadTokens ?? usage.cachedTokens;

const usageReported = (usage: TurnUsage): EventPayload => ({
  _tag: "UsageReported",
  inputTokens: usage.input,
  outputTokens: usage.output,
  cachedInputTokens: usage.cached,
  ...(usage.priced ? { costUsd: usage.costUsd } : {}),
});

const stopReason = (params: TurnCompletedParams): Payload<"TurnCompleted">["stopReason"] => {
  switch (params.terminal) {
    case "completed":
      return "completed";
    case "cancelled":
      return "interrupted";
    default:
      return params.error?.kind === "stepLimit" ? "maxTurns" : "error";
  }
};

/** A failed turn's error. Mid-turn failures reach clients here, never as JSON-RPC errors. */
const turnErrors = (params: TurnCompletedParams): ReadonlyArray<EventPayload> => {
  if (params.terminal !== "failed") return [];
  const { error } = params;
  if (error === undefined) {
    // A terminal synthesized after the host died carries only `reason` (crash, crash_inferred, incomplete).
    return [
      {
        _tag: "AgentError",
        kind: "crash",
        message: `Muse Code stopped the turn (${params.reason ?? "unknown reason"})`,
        retryable: true,
      },
    ];
  }
  if (error.kind === "authRequired") {
    return [{ _tag: "AuthRequired", provider: "muse", reason: error.message, loginCommand: LOGIN_COMMAND }];
  }
  if (error.quota !== undefined) {
    return [{ _tag: "AgentError", kind: "rateLimit", message: error.message, retryable: true }];
  }
  if (error.kind === "stepLimit") return [];
  return [
    {
      _tag: "AgentError",
      kind: error.retryable ? "transient" : "unknown",
      message: error.message,
      retryable: error.retryable,
    },
  ];
};

/** Tool arguments are the model's JSON verbatim; anything unparsable is kept as text. */
const parseArgs = (args: string | undefined): unknown => {
  if (args === undefined || args === "") return {};
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
};

const PATCH_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const PATCH_MOVE = /^\*\*\* Move to: (.+)$/;

/** Files a successful built-in edit tool changed, from its arguments. Shell commands are not tracked. */
const fileChanges = (item: Item, workspace: string): ReadonlyArray<EventPayload> => {
  const args = parseArgs(item.args);
  const record = Predicate.isObject(args) ? args : {};
  const resolve = (file: unknown) =>
    Predicate.isString(file) && file !== "" ? (isAbsolute(file) ? file : join(workspace, file)) : undefined;
  const changed = (file: unknown, change: Payload<"FileChanged">["change"]): ReadonlyArray<EventPayload> => {
    const path = resolve(file);
    return path === undefined ? [] : [{ _tag: "FileChanged", path, change }];
  };

  switch (item.tool) {
    case "write_file":
      // A whole-file write whose diff removes nothing created the file (or filled an empty one).
      return changed(record["path"], item.patchSummary?.removed === 0 ? "created" : "modified");
    case "edit_file":
      return changed(record["path"], "modified");
    case "apply_patch": {
      const patch = Predicate.isString(record["patch"])
        ? record["patch"]
        : Predicate.isString(args)
          ? args
          : "";
      return patch.split(/\r?\n/).flatMap((line): ReadonlyArray<EventPayload> => {
        const moved = PATCH_MOVE.exec(line);
        if (moved) return changed(moved[1], "created");
        const header = PATCH_HEADER.exec(line);
        if (!header) return [];
        return changed(
          header[2],
          header[1] === "Add" ? "created" : header[1] === "Delete" ? "deleted" : "modified",
        );
      });
    }
    default:
      return [];
  }
};
