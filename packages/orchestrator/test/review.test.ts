import { makeFakeAdapter } from "@cerium/harness/testing";
import type { AgentEvent, AgentId, InputItem } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Fiber } from "effect";

import { Orchestrator } from "../src/index.ts";
import { recordEvents, testLayer } from "./fakes.ts";

const inputsOf = (events: ReadonlyArray<AgentEvent>, agentId: AgentId): ReadonlyArray<InputItem> =>
  events.flatMap((event) =>
    event.agentId === agentId && event.payload._tag === "TurnInput" ? event.payload.items : [],
  );

const startWorkThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator;
  return yield* orchestrator.createThread({
    title: "Test",
    mode: "work",
    cwd: ".",
    lead: { provider: "claude", model: "opus", access: "auto" },
  });
});

describe("Reviews", () => {
  it.live(
    "runs a read-only reviewer on another harness whose answer goes to the caller, not the lead",
    () => {
      const lead = makeFakeAdapter("claude");
      const reviewer = makeFakeAdapter("codex", {
        turnDuration: Duration.millis(30),
        reply: () => '{"findings": []}',
      });
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator;
        const { seen } = yield* recordEvents;
        const thread = yield* startWorkThread;

        const started = yield* orchestrator.startReview(
          thread.thread.id,
          { provider: "codex", model: "luna", effort: "high" },
          "review this diff",
        );
        assert.strictEqual(yield* started.reply, '{"findings": []}');

        const info = (yield* orchestrator.listAgents(thread.thread.id)).find(
          (agent) => agent.id === started.agentId,
        );
        assert.deepInclude(info, {
          parentId: thread.lead.id,
          role: "review",
          provider: "codex",
          model: "luna",
          effort: "high",
          access: "readOnly",
        });
        assert.include(reviewer.sessions[0]?.options.appendSystemPrompt ?? "", "code reviewer");
        assert.notInclude(reviewer.sessions[0]?.options.appendSystemPrompt ?? "", "spawn_agent");
        assert.include(reviewer.sessions[0]?.sent[0] ?? "", "review this diff");

        // It stops once it has answered, and the lead never hears from it.
        yield* Effect.sleep(Duration.millis(100));
        assert.isFalse((yield* orchestrator.agent(started.agentId).pipe(Effect.option))._tag === "Some");
        assert.isUndefined(
          inputsOf(seen, thread.lead.id).find(
            (item) => item._tag === "ChildFinishedTurn" || item._tag === "FromAgent",
          ),
        );
      }).pipe(Effect.provide(testLayer([lead.adapter, reviewer.adapter])), Effect.scoped);
    },
  );

  it.live("fails the review when the reviewer is stopped, and keeps the role and messages from leads", () => {
    const lead = makeFakeAdapter("claude");
    const reviewer = makeFakeAdapter("codex", { turnDuration: Duration.seconds(30) });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const thread = yield* startWorkThread;
      const started = yield* orchestrator.startReview(
        thread.thread.id,
        { provider: "codex", model: "luna" },
        "review",
      );
      const waiting = yield* Effect.forkChild(Effect.flip(started.reply));

      const reasons = yield* Effect.forEach(
        [
          orchestrator.sendMessage(thread.lead.id, started.agentId, "hello").pipe(Effect.asVoid),
          orchestrator.sendMessage(started.agentId, thread.lead.id, "hello").pipe(Effect.asVoid),
          orchestrator.spawn(thread.lead.id, {
            role: "review",
            model: "luna",
            provider: "codex",
            prompt: "x",
          }),
        ],
        (attempt) => Effect.flip(attempt).pipe(Effect.map((error) => error.reason)),
      );
      assert.deepStrictEqual(reasons, ["notAllowed", "notAllowed", "invalid"]);

      yield* orchestrator.stopAgent(started.agentId);
      const failure = yield* Fiber.join(waiting);
      assert.include(failure.message, "stopped");

      const missing = yield* Effect.flip(
        orchestrator.startReview(thread.thread.id, { provider: "cursor", model: "composer" }, "review"),
      );
      assert.strictEqual(missing.reason, "unavailable");
    }).pipe(Effect.provide(testLayer([lead.adapter, reviewer.adapter])), Effect.scoped);
  });
});
