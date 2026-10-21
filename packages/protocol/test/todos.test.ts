import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import { AgentEvent, sameTodos, UiEvents } from "../src/index.ts";

const decodeEvent = Schema.decodeUnknownEffect(AgentEvent);
const encodeEvent = Schema.encodeEffect(AgentEvent);

const envelope = {
  id: "evt_1",
  threadId: "thr_1",
  agentId: "agt_1",
  sequence: 0,
  at: 1_760_000_000_000,
};

describe("TodosUpdated", () => {
  it.effect("keeps the whole list and survives a JSON round trip", () =>
    Effect.gen(function* () {
      const payload = {
        _tag: "TodosUpdated",
        items: [
          { id: "1", text: "Write the tests", status: "completed" },
          { id: "2", text: "Fix the build", status: "inProgress", activeText: "Fixing the build" },
          { text: "Ship it", status: "pending" },
          { text: "Port the docs", status: "cancelled" },
        ],
        explanation: "The docs moved to another repo",
      } as const;
      const event = yield* decodeEvent({ ...envelope, payload, raw: { original: true } });
      assert.deepStrictEqual(event.payload, payload);
      const encoded = yield* encodeEvent(event);
      assert.deepStrictEqual(yield* decodeEvent(JSON.parse(JSON.stringify(encoded))), event);
    }),
  );

  it.effect("reads an empty list, which clears it", () =>
    Effect.gen(function* () {
      const event = yield* decodeEvent({ ...envelope, payload: { _tag: "TodosUpdated", items: [] } });
      assert.deepStrictEqual(event.payload, { _tag: "TodosUpdated", items: [] });
    }),
  );

  it.effect("reads a status it doesn't know as pending and ignores fields it doesn't know", () =>
    Effect.gen(function* () {
      const event = yield* decodeEvent({
        ...envelope,
        payload: {
          _tag: "TodosUpdated",
          items: [{ text: "Review", status: "blocked", assignee: "someone" }],
        },
      });
      assert.deepStrictEqual(event.payload, {
        _tag: "TodosUpdated",
        items: [{ text: "Review", status: "pending" }],
      });
    }),
  );

  it.effect("rejects a list that isn't a list", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(decodeEvent({ ...envelope, payload: { _tag: "TodosUpdated" } }));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("travels in the lists a device reads, between the events around it", () =>
    Effect.gen(function* () {
      const written = [
        {
          ...envelope,
          sequence: 0,
          payload: { _tag: "MessageCompleted", messageId: "m1", text: "Planning" },
        },
        {
          ...envelope,
          sequence: 1,
          payload: { _tag: "TodosUpdated", items: [{ text: "Step", status: "pending" }] },
        },
        { ...envelope, sequence: 2, payload: { _tag: "TurnCompleted", stopReason: "completed" } },
      ];
      const events = yield* Schema.decodeUnknownEffect(UiEvents)(written);
      assert.deepStrictEqual(
        events.map((each) => each.payload._tag),
        ["MessageCompleted", "TodosUpdated", "TurnCompleted"],
      );
      assert.deepStrictEqual(yield* Schema.encodeEffect(UiEvents)(events), written);
    }),
  );
});

describe("sameTodos", () => {
  it("reads two lists as the same only when every item's id, text, status and present tense match", () => {
    const one = { id: "1", text: "One", status: "pending", activeText: "Doing one" } as const;
    assert.isTrue(sameTodos([one], [{ ...one }]));
    assert.isTrue(sameTodos([], []));
    assert.isFalse(sameTodos([one], []));
    assert.isFalse(sameTodos([one], [{ ...one, id: "2" }]));
    assert.isFalse(sameTodos([one], [{ ...one, text: "Two" }]));
    assert.isFalse(sameTodos([one], [{ ...one, status: "completed" }]));
    assert.isFalse(sameTodos([one], [{ ...one, activeText: "Doing it" }]));
  });
});
