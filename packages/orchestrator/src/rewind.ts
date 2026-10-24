import type { TurnRef } from "@cerium/harness";
import type { AgentEvent, AgentId, FromUser } from "@cerium/protocol";

import { renderTurn } from "./prompts.ts";

// Going back to before one of the user's messages. The event log stays append-only: a
// `ConversationRewound` marks the events it replaced, and everything that reads the conversation
// reads it without them.

/** An agent's events without the versions rewinds replaced; each rewind's own event stays. */
export const liveEvents = (events: ReadonlyArray<AgentEvent>): ReadonlyArray<AgentEvent> => {
  const live: Array<AgentEvent> = [];
  for (const event of events) {
    if (event.payload._tag === "ConversationRewound") {
      const from = event.payload.fromSequence;
      while (live.length > 0 && (live.at(-1)?.sequence ?? -1) >= from) live.pop();
    }
    live.push(event);
  }
  return live;
};

/** The user's messages an agent's live events queued and no turn delivered, nor the user took back. */
export const undeliveredIds = (events: ReadonlyArray<AgentEvent>): ReadonlySet<string> => {
  const waiting = new Set<string>();
  for (const { payload } of events) {
    if (payload._tag === "MessageQueued" && payload.message.id !== undefined) waiting.add(payload.message.id);
    if (payload._tag === "MessageWithdrawn") waiting.delete(payload.messageId);
    if (payload._tag === "TurnInput") {
      for (const item of payload.items) if (item._tag === "FromUser" && item.id) waiting.delete(item.id);
    }
    // Every message queued before a rewind went with the turns it replaced.
    if (payload._tag === "ConversationRewound") waiting.clear();
  }
  return waiting;
};

/** Where a rewind to before one of the user's messages goes back to, and how its session follows. */
export interface RewindPoint {
  /** The sequence of the turn that delivered the message: it and everything after are replaced. */
  readonly fromSequence: number;
  readonly message: FromUser;
  /**
   * How the session goes back: `fresh` when nothing comes before the message, `fork` before `turn`
   * of the session the agent runs (where its harness can fork), else `replay`.
   */
  readonly via: "fresh" | "fork" | "replay";
  readonly turn: TurnRef;
  /** The agents the lead spawned in what is replaced. */
  readonly spawned: ReadonlyArray<AgentId>;
}

/** Where going back to before the message `messageId` goes, or why it can't. */
export const rewindPoint = (
  events: ReadonlyArray<AgentEvent>,
  messageId: string,
): RewindPoint | { readonly problem: string } => {
  const live = liveEvents(events);
  let message: FromUser | undefined;
  const at = live.findIndex(({ payload }) => {
    if (payload._tag !== "TurnInput") return false;
    message = payload.items.find(
      (item): item is FromUser => item._tag === "FromUser" && item.id === messageId,
    );
    return message !== undefined;
  });
  const turnEvent = live[at];
  if (message === undefined || turnEvent?.payload._tag !== "TurnInput") {
    const queued = live.some(
      ({ payload }) => payload._tag === "MessageQueued" && payload.message.id === messageId,
    );
    return {
      problem: queued
        ? "That message hasn't reached the agent yet."
        : "That message is no longer in the conversation.",
    };
  }
  // The session the agent runs holds the turns since the last rewind that started a new one.
  let base = -1;
  let before = 0;
  for (const [index, { payload }] of live.slice(0, at).entries()) {
    if (payload._tag === "ConversationRewound" && payload.via !== "fork") base = index;
    if (payload._tag === "TurnInput") before++;
  }
  const index = live.slice(base + 1, at).filter(({ payload }) => payload._tag === "TurnInput").length;
  const turnId = turnEvent.payload.turnId;
  return {
    fromSequence: turnEvent.sequence,
    message,
    via: before === 0 ? "fresh" : index === 0 ? "replay" : "fork",
    turn: { index, ...(turnId === undefined ? {} : { id: turnId }) },
    spawned: live
      .slice(at)
      .flatMap(({ payload }) => (payload._tag === "AgentSpawned" ? [payload.childId] : [])),
  };
};

/**
 * Whether the agent's next session starts anew: the last rewind didn't fork, and no session has
 * started since.
 */
export const startsAnew = (live: ReadonlyArray<AgentEvent>): boolean => {
  for (let index = live.length - 1; index >= 0; index--) {
    const { payload } = live[index] ?? {};
    if (payload?._tag === "SessionStarted") return false;
    if (payload?._tag === "ConversationRewound") return payload.via !== "fork";
  }
  return false;
};

/** How much of the conversation a replay tells a new session, in characters. */
const REPLAY_BUDGET = 60_000;
/** The most a replay quotes of one message. */
const REPLAY_MESSAGE = 6_000;
const REPLAY_PREFACE = "This session continues an earlier conversation your harness couldn't carry over.";

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)} […]`);

/**
 * The conversation a session that couldn't fork is told, when the last rewind replays it and the
 * new session has taken no turn yet: each turn's input and the agent's last message of it, the
 * newest kept when it runs long.
 */
export const replayNotice = (live: ReadonlyArray<AgentEvent>): string | undefined => {
  let rewound = -1;
  for (const [index, { payload }] of live.entries()) {
    if (payload._tag === "ConversationRewound") rewound = payload.via === "replay" ? index : -1;
    if (payload._tag === "TurnInput" && index > rewound) rewound = -1;
  }
  if (rewound === -1) return undefined;
  const turns: Array<{ input: string; reply?: string }> = [];
  for (const { payload } of live.slice(0, rewound)) {
    if (payload._tag === "TurnInput") {
      // An earlier replay is the conversation before it, which this one tells again.
      const items = payload.items.filter(
        (item) => item._tag !== "SystemNotice" || !item.text.startsWith(REPLAY_PREFACE),
      );
      turns.push({ input: items.length === 0 ? "" : renderTurn(items) });
    }
    const last = turns.at(-1);
    if (payload._tag === "MessageCompleted" && last !== undefined) last.reply = payload.text;
  }
  const told: Array<string> = [];
  let used = 0;
  for (const turn of turns.toReversed()) {
    const entry = [
      `[Input]\n${clip(turn.input, REPLAY_MESSAGE)}`,
      ...(turn.reply === undefined ? [] : [`[You]\n${clip(turn.reply, REPLAY_MESSAGE)}`]),
    ].join("\n\n");
    if (used + entry.length > REPLAY_BUDGET && told.length > 0) break;
    told.unshift(entry);
    used += entry.length;
  }
  return [
    `${REPLAY_PREFACE} The user went back to an earlier point of it; their next message follows this` +
      " notice. Here is the conversation up to that point" +
      (told.length < turns.length ? ` (its last ${told.length} of ${turns.length} turns)` : "") +
      "; the tools you used aren't shown, so look again at anything you need.",
    ...told,
  ].join("\n\n");
};
