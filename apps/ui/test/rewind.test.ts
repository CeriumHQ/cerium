import type { AgentEvent, AgentId, EventId, EventPayload, ThreadId } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { layout } from "../src/features/transcript/layout.ts";
import { buildTranscript, holdsQueue, queuedMessages } from "../src/features/transcript/model.ts";

const events = (...payloads: ReadonlyArray<EventPayload>): ReadonlyArray<AgentEvent> =>
  payloads.map((payload, sequence) => ({
    id: `e${sequence}` as EventId,
    threadId: "t" as ThreadId,
    agentId: "a" as AgentId,
    sequence,
    at: sequence,
    payload,
  }));

const asked = (id: string, text: string): ReadonlyArray<EventPayload> => [
  { _tag: "MessageQueued", message: { _tag: "FromUser", id, text } },
  { _tag: "TurnInput", items: [{ _tag: "FromUser", id, text }] },
];
const answered = (text: string): ReadonlyArray<EventPayload> => [
  { _tag: "MessageCompleted", messageId: text, text },
  { _tag: "TurnCompleted", stopReason: "completed" },
];

describe("edited messages", () => {
  // The first turn spans sequences 0–3, the second 4–7, so "two"'s turn starts at 5.
  const conversation = [
    ...asked("m1", "one"),
    ...answered("first"),
    ...asked("m2", "two"),
    ...answered("second"),
  ];

  it("folds the turns a rewind replaced into one block, the new message after it", () => {
    const blocks = buildTranscript(
      events(
        ...conversation,
        { _tag: "ConversationRewound", fromSequence: 5, messageId: "m2", via: "fork" },
        ...asked("m3", "two, better"),
        ...answered("better"),
      ),
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      "user",
      "message",
      "turnEnd",
      "replaced",
      "user",
      "message",
      "turnEnd",
    ]);
    const replaced = blocks[3];
    expect(replaced?.kind === "replaced" && replaced.blocks.map((block) => block.kind)).toEqual([
      "user",
      "message",
      "turnEnd",
    ]);
    expect(blocks[4]).toMatchObject({ kind: "user", id: "m3", text: "two, better", delivered: true });

    const items = layout(blocks);
    const folded = items.find((item) => item.kind === "replaced");
    expect(folded).toMatchObject({ kind: "replaced", turns: 1 });
    // The new message starts a response of its own, under its own header.
    expect(items.slice(-4).map((item) => item.kind)).toEqual(["input", "header", "block", "turnEnd"]);
  });

  it("nests an earlier version inside a later rewind that goes back further", () => {
    const blocks = buildTranscript(
      events(
        ...conversation,
        { _tag: "ConversationRewound", fromSequence: 5, messageId: "m2", via: "fork" },
        ...asked("m3", "two, better"),
        { _tag: "ConversationRewound", fromSequence: 1, messageId: "m1", via: "fresh" },
      ),
    );
    expect(blocks.map((block) => block.kind)).toEqual(["replaced"]);
    const outer = blocks[0];
    expect(outer?.kind === "replaced" && outer.blocks.map((block) => block.kind)).toEqual([
      "user",
      "message",
      "turnEnd",
      "replaced",
      "user",
    ]);
  });

  it("forgets messages that waited behind the replaced turns", () => {
    const queued = queuedMessages(
      events(
        ...asked("m1", "one"),
        { _tag: "MessageQueued", message: { _tag: "FromUser", id: "m2", text: "two" } },
        {
          _tag: "ConversationRewound",
          fromSequence: 1,
          messageId: "m1",
          via: "fresh",
        },
      ),
    );
    expect(queued).toEqual({ messages: [], behindTurn: false });
  });
});

describe("withdrawn messages", () => {
  const waiting = events(
    { _tag: "MessageQueued", message: { _tag: "FromUser", id: "m1", text: "one" } },
    { _tag: "TurnInput", items: [{ _tag: "FromUser", id: "m1", text: "one" }] },
    { _tag: "MessageQueued", message: { _tag: "FromUser", id: "m2", text: "two" } },
    { _tag: "MessageQueued", message: { _tag: "FromUser", id: "m3", text: "three" } },
    { _tag: "MessageWithdrawn", messageId: "m2" },
  );

  it("leave the queue, and the rest keep their order", () => {
    const queued = queuedMessages(waiting);
    expect(queued.messages.map((message) => message.text)).toEqual(["three"]);
    expect(queued.behindTurn).toBe(true);
  });

  it("wait in the box only behind a running turn or for an ended lead", () => {
    const queued = queuedMessages(waiting);
    expect(holdsQueue(queued, "running")).toBe(true);
    expect(holdsQueue(queued, "ended")).toBe(true);
    expect(holdsQueue(queued, "idle")).toBe(false);
    expect(holdsQueue(queuedMessages([]), "running")).toBe(false);
  });
});
