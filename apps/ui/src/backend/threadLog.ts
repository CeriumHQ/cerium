import type { AgentEvent, EventPayload } from "@cerium/protocol";

/** Events in the order they happened; ties keep each agent's own order. */
export const byTime = (a: AgentEvent, b: AgentEvent) => a.at - b.at || a.sequence - b.sequence;

/** The streamed block a delta grows, keyed as the transcript keys it. */
const streamedBlock = (payload: EventPayload): string | undefined => {
  switch (payload._tag) {
    case "MessageDelta":
      return `message:${payload.messageId}`;
    case "ReasoningDelta":
      return `reasoning:${payload.messageId}`;
    default:
      return undefined;
  }
};

/** The streamed block a completion finishes. */
const finishedBlock = (payload: EventPayload): string | undefined => {
  switch (payload._tag) {
    case "MessageCompleted":
      return `message:${payload.messageId}`;
    case "ReasoningCompleted":
      return `reasoning:${payload.messageId}`;
    default:
      return undefined;
  }
};

/**
 * One thread's events as the window holds them: each once, in the order they happened, from
 * history and the live feed alike, taken a batch at a time.
 *
 * A reply streams in as one delta per few words, and its completion carries the whole text, so a
 * block's deltas are dropped once it completes, all but its first, which keeps the block where it
 * started. Without that, a thread holds every word of every reply it streamed, and every pass
 * over its events walks them all.
 */
export class ThreadLog {
  #events: Array<AgentEvent> = [];
  readonly #seen = new Set<string>();
  /** Streamed blocks with deltas held. */
  readonly #streaming = new Set<string>();
  /** Streamed blocks that completed: later deltas for them add nothing. */
  readonly #finished = new Set<string>();

  /** Takes a batch of events; returns whether the log changed. */
  add(batch: Iterable<AgentEvent>): boolean {
    let changed = false;
    let unordered = false;
    const completed = new Set<string>();
    for (const event of batch) {
      if (this.#seen.has(event.id)) continue;
      this.#seen.add(event.id);
      const streamed = streamedBlock(event.payload);
      if (streamed !== undefined) {
        if (this.#finished.has(streamed)) continue;
        this.#streaming.add(streamed);
      }
      const finished = finishedBlock(event.payload);
      if (finished !== undefined) {
        this.#finished.add(finished);
        if (this.#streaming.delete(finished)) completed.add(finished);
      }
      const last = this.#events.at(-1);
      if (last !== undefined && byTime(last, event) > 0) unordered = true;
      this.#events.push(event);
      changed = true;
    }
    if (!changed) return false;
    if (unordered) this.#events.sort(byTime);
    if (completed.size > 0) {
      const kept = new Set<string>();
      this.#events = this.#events.filter((event) => {
        const streamed = streamedBlock(event.payload);
        if (streamed === undefined || !completed.has(streamed)) return true;
        if (kept.has(streamed)) return false;
        kept.add(streamed);
        return true;
      });
    }
    return true;
  }

  /** A copy of the events now, for a reader that keeps it. */
  snapshot(): ReadonlyArray<AgentEvent> {
    return this.#events.slice();
  }
}
