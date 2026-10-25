import type { AgentEvent, EventId, EventPayload, ThreadId } from "@cerium/protocol";

type Delta = Extract<EventPayload, { readonly _tag: "MessageDelta" | "ReasoningDelta" }>;

/** A block still streaming: the event of its first delta, and its text so far. */
interface Streaming {
  readonly first: AgentEvent;
  readonly tag: Delta["_tag"];
  readonly messageId: string;
  text: string;
}

const blockKey = (agentId: string, tag: Delta["_tag"], messageId: string) =>
  `${agentId}\n${tag}\n${messageId}`;

/** Whether an event ends its agent's turn, and with it any block the turn left streaming. */
const endsTurn = (payload: EventPayload) =>
  payload._tag === "TurnCompleted" ||
  (payload._tag === "AgentStateChanged" && payload.state !== "running" && payload.state !== "queued");

/**
 * The text of each reply and reasoning block still streaming. Streamed text is never stored, so a
 * reader that joins mid-reply (a window opened or reconnected while an agent writes) reads it from
 * here. A block is forgotten once it completes, or once its agent's turn ends without completing it.
 */
export class StreamedText {
  readonly #blocks = new Map<string, Streaming>();

  /** Notes an event as it's recorded; returns it with a delta's `offset` in its block set. */
  note(event: AgentEvent): AgentEvent {
    const { payload } = event;
    if (payload._tag === "MessageDelta" || payload._tag === "ReasoningDelta") {
      const key = blockKey(event.agentId, payload._tag, payload.messageId);
      let block = this.#blocks.get(key);
      if (block === undefined) {
        block = { first: event, tag: payload._tag, messageId: payload.messageId, text: "" };
        this.#blocks.set(key, block);
      }
      const offset = block.text.length;
      block.text += payload.text;
      return { ...event, payload: { ...payload, offset } };
    }
    if (payload._tag === "MessageCompleted" || payload._tag === "ReasoningCompleted") {
      const tag = payload._tag === "MessageCompleted" ? "MessageDelta" : "ReasoningDelta";
      this.#blocks.delete(blockKey(event.agentId, tag, payload.messageId));
    } else if (endsTurn(payload)) {
      for (const [key, block] of this.#blocks) {
        if (block.first.agentId === event.agentId) this.#blocks.delete(key);
      }
    }
    return event;
  }

  /**
   * Each of a thread's blocks still streaming, as one delta holding its text so far, in its first
   * delta's place. Its id is its own, and changes as the text grows, so a reader that held an
   * earlier one takes the longer text too.
   */
  soFar(threadId: ThreadId): ReadonlyArray<AgentEvent> {
    return [...this.#blocks.values()].flatMap(({ first, tag, messageId, text }) => {
      if (first.threadId !== threadId) return [];
      const { raw: _raw, ...event } = first;
      return [
        {
          ...event,
          id: `${first.id}:${text.length}` as EventId,
          payload: { _tag: tag, messageId, text, offset: 0 },
        },
      ];
    });
  }
}
