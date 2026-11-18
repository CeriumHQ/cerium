import { makeFakeAdapter } from "@cerium/harness/testing";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { Orchestrator } from "../src/index.ts";
import { recordEvents, testLayer } from "./fakes.ts";

describe("Composer follow-up", () => {
  it.live("shares one suggestion for a completed reply, sends it only on request, and can abstain", () => {
    const suggestion = "Run the compatibility check.";
    const fake = makeFakeAdapter("claude", {
      reply: (text) => (text === suggestion ? "The check passed." : "Only the compatibility check remains."),
      complete: ({ prompt }) => (prompt.includes("The check passed.") ? "null" : JSON.stringify(suggestion)),
    });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* orchestrator.createThread({
        title: "Migration",
        mode: "chat",
        lead: { provider: "claude", model: "opus", access: "readOnly" },
      });
      const ask = (afterSeq: number) => orchestrator.suggestFollowup(lead.threadId, lead.id, afterSeq);
      const completedAfter = (seq: number) =>
        waitFor((events) =>
          events.find((event) => event.sequence > seq && event.payload._tag === "TurnCompleted"),
        );
      yield* orchestrator.sendUserMessage(lead.id, "Check the migration.");
      const first = yield* completedAfter(-1);
      const replies = yield* Effect.all([ask(first.sequence), ask(first.sequence)], { concurrency: 2 });
      assert.deepStrictEqual(replies, [suggestion, suggestion]);
      const calls = fake.completions.filter(({ prompt }) =>
        prompt.includes("Only the compatibility check remains."),
      );
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0]?.model, "opus");
      assert.include(calls[0]?.prompt ?? "", "Check the migration.");
      assert.deepStrictEqual(fake.sessions[0]?.sent, ["Check the migration."]);
      yield* orchestrator.sendUserMessage(lead.id, suggestion);
      const second = yield* completedAfter(first.sequence);
      assert.isNull(yield* ask(first.sequence));
      assert.isNull(yield* ask(second.sequence));
      assert.deepStrictEqual(fake.sessions[0]?.sent, ["Check the migration.", suggestion]);
    }).pipe(Effect.provide(testLayer([fake.adapter])));
  });
});
