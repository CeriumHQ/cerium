import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";

import { AgentEvent, answerText } from "../src/index.ts";

const decodeEvent = Schema.decodeUnknownEffect(AgentEvent);

const envelope = {
  id: "evt_1",
  threadId: "thr_1",
  agentId: "agt_1",
  sequence: 0,
  at: 1_760_000_000_000,
};

describe("AgentEvent", () => {
  it.effect("rejects a turn input with no items", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decodeEvent({ ...envelope, payload: { _tag: "TurnInput", items: [] } }),
      );
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("rejects unknown payload kinds", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(decodeEvent({ ...envelope, payload: { _tag: "Telepathy" } }));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("reads a question's resolution of a kind this version doesn't know as expired", () =>
    Effect.gen(function* () {
      const event = yield* decodeEvent({
        ...envelope,
        payload: { _tag: "QuestionResolved", requestId: "q1", outcome: "postponed" },
      });
      assert.deepStrictEqual(event.payload, {
        _tag: "QuestionResolved",
        requestId: "q1",
        outcome: "expired",
      });
    }),
  );

  it.effect("rejects a question with nothing to ask", () =>
    Effect.gen(function* () {
      const asked = { _tag: "QuestionAsked", requestId: "q1" };
      const question = { question: "Which?", options: [], multiSelect: false, allowOther: true };
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(decodeEvent({ ...envelope, payload: { ...asked, questions: [] } })),
        ),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            decodeEvent({ ...envelope, payload: { ...asked, questions: [{ ...question, question: "" }] } }),
          ),
        ),
      );
      assert.isTrue(
        Exit.isSuccess(
          yield* Effect.exit(decodeEvent({ ...envelope, payload: { ...asked, questions: [question] } })),
        ),
      );
    }),
  );

  it("writes an answer as one line, the picks first", () => {
    assert.strictEqual(answerText({ choices: ["A", "B"], text: " and more " }), "A, B, and more");
    assert.strictEqual(answerText({ choices: [], text: "just words" }), "just words");
    assert.strictEqual(answerText({ choices: ["A"], text: "  " }), "A");
  });
});
