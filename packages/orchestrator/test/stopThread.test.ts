import { makeFakeAdapter } from "@cerium/harness/testing";
import type { AgentEvent, AgentId } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect } from "effect";

import { Orchestrator, type CatalogEntry } from "../src/index.ts";
import { recordEvents, testLayer } from "./fakes.ts";

const scout: CatalogEntry = { alias: "scout", provider: "claude", model: "haiku", description: "Lookups" };

const startWorkThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator;
  return yield* orchestrator.createThread({
    title: "Test",
    mode: "work",
    cwd: ".",
    lead: { provider: "claude", model: "opus", access: "ask" },
  });
});

const idleOf = (events: ReadonlyArray<AgentEvent>, agentId: AgentId) =>
  events.find(
    (event) =>
      event.agentId === agentId &&
      event.payload._tag === "AgentStateChanged" &&
      event.payload.state === "idle",
  );

describe("Orchestrator.stopThread", () => {
  it.live("denies what waits on the user, ends every turn and wakes nobody", () => {
    const fake = makeFakeAdapter("claude", { askPermission: true });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { seen, waitFor } = yield* recordEvents;
      const { thread, lead } = yield* startWorkThread;

      yield* orchestrator.sendUserMessage(lead.id, "go");
      yield* waitFor((events) =>
        events.find((event) => event.agentId === lead.id && event.payload._tag === "PermissionRequested"),
      );
      const outcome = yield* orchestrator.spawn(lead.id, { role: "scout", model: "scout", prompt: "look" });
      const childId = outcome._tag === "Spawned" ? outcome.agentId : ("" as AgentId);
      // The child's request goes to its lead, not the user.
      // Nothing shows when the orchestrator has taken the request, so it gets time, even on a busy machine.
      yield* Effect.sleep(Duration.millis(600));
      assert.strictEqual(fake.sessions[1]?.sent.length, 1, "the child is mid-turn");
      yield* orchestrator.spawn(lead.id, {
        role: "reviewer",
        model: "sonnet",
        provider: "claude",
        prompt: "Review",
      });
      assert.isTrue(orchestrator.awaitingApproval(thread.id));

      const stopped = yield* orchestrator.stopThread(thread.id);
      assert.deepStrictEqual(stopped, { agents: 2, approvals: 3 });

      yield* waitFor((events) => idleOf(events, lead.id));
      yield* waitFor((events) => idleOf(events, childId));
      assert.isFalse(orchestrator.awaitingApproval(thread.id));
      assert.isTrue(
        seen.some(
          (event) => event.payload._tag === "SpawnApprovalResolved" && event.payload.decision === "deny",
        ),
      );
      assert.isTrue(
        seen.some(
          (event) =>
            event.agentId === lead.id &&
            event.payload._tag === "PermissionResolved" &&
            event.payload.decision === "deny",
        ),
      );

      // The child's finished turn doesn't report back, and the notice about its request is dropped.
      yield* Effect.sleep(Duration.millis(150));
      assert.deepStrictEqual(fake.sessions[0]?.sent, ["go"], "the lead starts no turn of its own accord");

      const nothing = yield* orchestrator.stopThread(thread.id);
      assert.deepStrictEqual(nothing, { agents: 0, approvals: 0 });
    }).pipe(Effect.provide(testLayer([fake.adapter], { catalog: [scout] })), Effect.scoped);
  });

  it.live("interrupts a turn that is still working and leaves the session for the next message", () => {
    const fake = makeFakeAdapter("claude", { turnDuration: Duration.seconds(30) });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { seen, waitFor } = yield* recordEvents;
      const { thread, lead } = yield* startWorkThread;

      yield* orchestrator.sendUserMessage(lead.id, "go");
      yield* waitFor((events) =>
        events.find(
          (event) => event.payload._tag === "AgentStateChanged" && event.payload.state === "running",
        ),
      );
      assert.deepStrictEqual(yield* orchestrator.stopThread(thread.id), { agents: 1, approvals: 0 });

      yield* waitFor((events) => idleOf(events, lead.id));
      assert.isTrue(
        seen.some(
          (event) => event.payload._tag === "TurnCompleted" && event.payload.stopReason === "interrupted",
        ),
      );
      assert.strictEqual((yield* orchestrator.agent(lead.id)).state, "idle");
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });
});
