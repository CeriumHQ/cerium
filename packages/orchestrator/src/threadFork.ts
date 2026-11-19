import type { AgentEvent, EventPayload, ModelChoice } from "@cerium/protocol";

import { liveEvents, startsSession } from "./rewind.ts";

export const FORK_TAGS: ReadonlyArray<EventPayload["_tag"]> = [
  "TurnInput",
  "TurnCompleted",
  "MessageCompleted",
  "FilesSaved",
  "ConversationRewound",
  "ForkContext",
  "SessionStarted",
  "ModelChanged",
  "LeadHandedOff",
  "WorkspaceMoved",
];

/** The conversation and file checkpoint at a turn's end, with its position in the live session. */
export const threadForkPoint = (
  events: ReadonlyArray<AgentEvent>,
  key: string,
  cwd: string,
  lead: ModelChoice,
) => {
  const live = liveEvents(events);
  const at = live.findIndex(
    ({ id, payload }) =>
      payload._tag === "TurnInput" &&
      (id === key ||
        payload.turnId === key ||
        payload.items.some((item) => item._tag === "FromUser" && item.id === key)),
  );
  const input = live[at];
  if (input?.payload._tag !== "TurnInput") return undefined;
  const turnId = input.payload.turnId;
  const end = live.findIndex(
    ({ payload }, index) => index > at && (payload._tag === "TurnCompleted" || payload._tag === "TurnInput"),
  );
  const completed = live[end]?.payload._tag === "TurnCompleted";
  const cutoff = end === -1 ? live.length : end + (completed ? 1 : 0);
  const boundary = live.findLastIndex(({ payload }) => startsSession(payload));
  const snapshots = new Map(
    events.flatMap(({ payload }) =>
      payload._tag === "FilesSaved" && payload.turnId !== undefined
        ? [[payload.turnId, payload] as const]
        : [],
    ),
  );
  const moves = events.filter(
    (event): event is AgentEvent & { payload: Extract<EventPayload, { _tag: "WorkspaceMoved" }> } =>
      event.payload._tag === "WorkspaceMoved",
  );
  const history: Array<{ at: number; payload: EventPayload }> = [];
  let from = lead;
  let inheritedBoundary = 0;
  let snapshot: Extract<EventPayload, { _tag: "FilesSaved" }> | undefined;
  for (const [index, { id, at: time, sequence, payload }] of live.slice(0, cutoff).entries()) {
    if (index === boundary) inheritedBoundary = history.length;
    switch (payload._tag) {
      case "SessionStarted":
      case "LeadHandedOff":
      case "WorkspaceMoved":
        from = { provider: payload.provider, model: payload.model };
        break;
      case "ModelChanged":
        from = { ...from, model: payload.model };
        break;
      case "TurnInput": {
        // Inherited files are a source for new forks. Rewind and restore in the new thread may
        // only act on the files its own turns changed.
        const { files: _files, ...turn } = payload;
        history.push({ at: time, payload: { ...turn, turnId: turn.turnId ?? id } });
        const saved = payload.turnId === undefined ? undefined : snapshots.get(payload.turnId);
        if (saved !== undefined) {
          const folder =
            saved.folder ?? moves.find((move) => move.sequence > sequence)?.payload.previousCwd ?? cwd;
          const inherited = { ...saved, folder };
          history.push({ at: time, payload: inherited });
          if (index === at) snapshot = inherited;
        }
        break;
      }
      case "MessageCompleted":
        history.push({ at: time, payload: { ...payload, messageId: `fork:${payload.messageId}` } });
        break;
      case "TurnCompleted":
        history.push({ at: time, payload });
        break;
    }
  }
  if (!completed)
    history.push({
      at: history.at(-1)?.at ?? input.at,
      payload: { _tag: "TurnCompleted", stopReason: "interrupted" },
    });
  return {
    history,
    inheritedBoundary: boundary >= 0 && boundary < at ? inheritedBoundary : undefined,
    from,
    snapshot,
    turn: turnId ?? input.id,
    turnId,
    completed,
    nativeTurn:
      completed && boundary < at
        ? {
            index: live.slice(boundary + 1, at).filter(({ payload }) => payload._tag === "TurnInput").length,
            ...(turnId === undefined ? {} : { id: turnId }),
          }
        : undefined,
  };
};
