import type { AgentEvent, AgentId, EventId, EventPayload, ThreadId } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";

import { StreamedText } from "../src/streamed.ts";

const event = (sequence: number, payload: EventPayload, agentId = "a"): AgentEvent => ({
  id: `${agentId}:${sequence}` as EventId,
  threadId: "t" as ThreadId,
  agentId: agentId as AgentId,
  sequence,
  at: 100 + sequence,
  payload,
});

const delta = (text: string): EventPayload => ({ _tag: "MessageDelta", messageId: "m", text });

describe("streamed text", () => {
  it("sets each delta's offset in its block", () => {
    const streamed = new StreamedText();
    const offsets = [delta("```art"), delta("ifact\n"), delta("<style>")].map((payload, sequence) => {
      const noted = streamed.note(event(sequence, payload)).payload;
      return noted._tag === "MessageDelta" ? noted.offset : undefined;
    });
    assert.deepStrictEqual(offsets, [0, 6, 12]);
  });

  it("gives a thread's blocks still streaming as their text so far, in their first delta's place", () => {
    const streamed = new StreamedText();
    streamed.note(event(3, delta("Hel")));
    streamed.note(event(4, { _tag: "ReasoningDelta", messageId: "r", text: "Hmm" }, "b"));
    streamed.note(event(5, delta("lo")));
    const soFar = streamed.soFar("t" as ThreadId);
    assert.deepStrictEqual(
      soFar.map(({ id, sequence, at, payload }) => ({ id, sequence, at, payload })),
      [
        {
          id: "a:3:5" as EventId,
          sequence: 3,
          at: 103,
          payload: { _tag: "MessageDelta", messageId: "m", text: "Hello", offset: 0 },
        },
        {
          id: "b:4:3" as EventId,
          sequence: 4,
          at: 104,
          payload: { _tag: "ReasoningDelta", messageId: "r", text: "Hmm", offset: 0 },
        },
      ],
    );
    assert.deepStrictEqual(streamed.soFar("other" as ThreadId), []);
  });

  it("forgets a block once it completes, or its agent's turn ends without completing it", () => {
    const streamed = new StreamedText();
    streamed.note(event(0, delta("Hel")));
    streamed.note(event(1, { _tag: "MessageCompleted", messageId: "m", text: "Hello" }));
    assert.deepStrictEqual(streamed.soFar("t" as ThreadId), []);

    streamed.note(event(2, { _tag: "MessageDelta", messageId: "n", text: "Cut" }));
    streamed.note(event(3, { _tag: "ReasoningDelta", messageId: "r", text: "Hmm" }, "b"));
    streamed.note(event(4, { _tag: "TurnCompleted", stopReason: "interrupted" }));
    assert.deepStrictEqual(
      streamed.soFar("t" as ThreadId).map(({ agentId }) => agentId),
      ["b" as AgentId],
    );
    streamed.note(event(5, { _tag: "AgentStateChanged", state: "stopped" }, "b"));
    assert.deepStrictEqual(streamed.soFar("t" as ThreadId), []);
  });
});
