import { Schema } from "effect";

import type { EventPayload } from "./events.ts";
import { HistoryCursor, THREAD_STATE_TAGS } from "./history.ts";
import { UiEvents, type UiEvent } from "./sync.ts";

/** Display order is independent of the order in which an imported event was stored. */
export const compareHistory = (a: HistoryCursor, b: HistoryCursor) =>
  a.at - b.at || a.sequence - b.sequence || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const ThreadStateView = Schema.Literals(["main", "artifacts", "files", "run"]);
export type ThreadStateView = typeof ThreadStateView.Type;

export const CloudThreadStateView = Schema.Literals(["main", "files"]);
export type CloudThreadStateView = typeof CloudThreadStateView.Type;

const coreTags: ReadonlySet<EventPayload["_tag"]> = new Set(THREAD_STATE_TAGS);
export const affectsThreadState = (event: UiEvent) => coreTags.has(event.payload._tag);

/** The artifact panel works from these candidates using the same Markdown parser as the transcript. */
export const isArtifactCandidate = (event: UiEvent) =>
  event.payload._tag === "MessageCompleted" && event.payload.text.includes("artifact");

export const ThreadStateCheckpoint = Schema.Struct({
  /** Latest folded event per agent. Older arrivals invalidate the checkpoint. */
  through: Schema.Record(Schema.String, HistoryCursor),
  events: UiEvents,
});
export type ThreadStateCheckpoint = typeof ThreadStateCheckpoint.Type;

export const emptyThreadState = (): ThreadStateCheckpoint => ({ through: {}, events: [] });

type AgentState = {
  readonly latest: Map<string, UiEvent>;
  readonly queued: Map<string, UiEvent>;
  readonly pending: Map<string, UiEvent>;
  context?: (UiEvent & { readonly payload: Extract<EventPayload, { _tag: "ContextReported" }> }) | undefined;
  usage?: (UiEvent & { readonly payload: Extract<EventPayload, { _tag: "UsageReported" }> }) | undefined;
};

const cursor = ({ at, sequence, id }: UiEvent): HistoryCursor => ({ at, sequence, id });

/** Only new inputs, or a rebuild from canonical history, may advance a checkpoint. */
export const canAdvanceThreadState = (
  state: ThreadStateCheckpoint,
  events: ReadonlyArray<UiEvent>,
): boolean =>
  events.every((event) => {
    const point = Object.hasOwn(state.through, event.agentId) ? state.through[event.agentId] : undefined;
    return !affectsThreadState(event) || point === undefined || compareHistory(point, event) < 0;
  });

/**
 * Fold the inputs its side panels need into a compact checkpoint. Its events are read by the
 * existing summary and queue folds, and never enter the transcript or export. Artifact candidates
 * and file changes have their own history since older entries can still contribute to those panels.
 */
export const advanceThreadState = (
  state: ThreadStateCheckpoint,
  events: ReadonlyArray<UiEvent>,
): ThreadStateCheckpoint => {
  const agents = new Map<string, AgentState>();
  const through = new Map(Object.entries(state.through));
  for (const event of [...state.events, ...events.filter(affectsThreadState)].sort(compareHistory)) {
    let agent = agents.get(event.agentId);
    if (agent === undefined) {
      agent = { latest: new Map(), queued: new Map(), pending: new Map() };
      agents.set(event.agentId, agent);
    }
    const { payload } = event;
    const point = through.get(event.agentId);
    if (point === undefined || compareHistory(point, event) < 0) through.set(event.agentId, cursor(event));
    switch (payload._tag) {
      case "UsageReported": {
        const before = agent.usage?.payload;
        const costUsd =
          before?.costUsd === undefined && payload.costUsd === undefined
            ? undefined
            : (before?.costUsd ?? 0) + (payload.costUsd ?? 0);
        agent.usage = {
          ...event,
          payload: {
            _tag: "UsageReported",
            inputTokens:
              (before?.inputTokens ?? 0) + (payload.inputTokens + (payload.cachedInputTokens ?? 0)),
            outputTokens: (before?.outputTokens ?? 0) + payload.outputTokens,
            ...(costUsd === undefined ? {} : { costUsd }),
          },
        };
        break;
      }
      case "ContextReported":
      case "ContextCompacted": {
        const tokens = payload._tag === "ContextReported" ? payload.tokens : payload.tokensAfter;
        const window =
          (payload._tag === "ContextReported" ? payload.window : undefined) ?? agent.context?.payload.window;
        agent.context =
          tokens === undefined
            ? undefined
            : {
                ...event,
                payload: { _tag: "ContextReported", tokens, ...(window === undefined ? {} : { window }) },
              };
        break;
      }
      case "SessionStarted": {
        const { ceriumInstructions: _instructions, ...model } = payload;
        agent.latest.set("model", { ...event, payload: model });
        break;
      }
      case "ModelChanged":
      case "LeadHandedOff":
        agent.latest.set("model", event);
        if (payload._tag === "LeadHandedOff") agent.context = undefined;
        else if (payload._tag === "ModelChanged" && agent.context !== undefined)
          agent.context = {
            ...agent.context,
            payload: { _tag: "ContextReported", tokens: agent.context.payload.tokens },
          };
        break;
      case "PermissionRequested":
        agent.pending.set("permission:" + payload.requestId, event);
        break;
      case "PermissionResolved":
        agent.pending.delete("permission:" + payload.requestId);
        break;
      case "SpawnApprovalRequested":
        agent.pending.set("spawn:" + payload.requestId, event);
        break;
      case "SpawnApprovalResolved":
        agent.pending.delete("spawn:" + payload.requestId);
        break;
      case "QuestionAsked":
        agent.pending.set("question:" + payload.requestId, event);
        break;
      case "QuestionResolved":
        agent.pending.delete("question:" + payload.requestId);
        break;
      case "MessageQueued": {
        const id = payload.message.id;
        if (id !== undefined) {
          const first = agent.queued.get(id);
          agent.queued.set(id, first === undefined ? event : { ...first, payload });
        }
        break;
      }
      case "TurnInput":
        for (const item of payload.items)
          if (item._tag === "FromUser" && item.id !== undefined) agent.queued.delete(item.id);
        // The checkpoint has already removed the inputs this turn consumed. Keep only its marker.
        agent.latest.set("turn", {
          ...event,
          payload: { _tag: "TurnInput", items: [{ _tag: "SystemNotice", text: "" }] },
        });
        break;
      case "TurnCompleted":
        // The run scoreboard measures time to the first completed turn.
        if (!agent.latest.has("firstCompleted")) agent.latest.set("firstCompleted", event);
        agent.latest.set("turn", event);
        break;
      case "MessageWithdrawn":
        agent.queued.delete(payload.messageId);
        break;
      case "ConversationRewound":
        agent.queued.clear();
        agent.context = undefined;
        agent.latest.set("turn", event);
        break;
      default:
        agent.latest.set(payload._tag, event);
    }
  }
  const kept = new Map<string, UiEvent>();
  for (const { latest, queued, pending, context, usage } of agents.values()) {
    for (const event of latest.values()) kept.set(event.id, event);
    for (const event of queued.values()) kept.set(event.id, event);
    for (const event of pending.values()) kept.set(event.id, event);
    if (context !== undefined) kept.set(context.id, context);
    if (usage !== undefined) kept.set(usage.id, usage);
  }
  return { through: Object.fromEntries(through), events: [...kept.values()].sort(compareHistory) };
};
