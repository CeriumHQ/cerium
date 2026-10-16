import type { AgentEvent, AgentId } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Exit } from "effect";

import { Orchestrator, type CatalogEntry } from "../src/index.ts";
import { makeFakeAdapter } from "@cerium/harness/testing";

import { recordEvents, testLayer } from "./fakes.ts";

const haiku: CatalogEntry = {
  alias: "scout",
  provider: "claude",
  model: "haiku",
  effort: "low",
  description: "Quick lookups",
};

const turnInputs = (events: ReadonlyArray<AgentEvent>, agentId: AgentId) =>
  events.flatMap((event) =>
    event.agentId === agentId && event.payload._tag === "TurnInput" ? [event.payload.items] : [],
  );

const startWorkThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator;
  return yield* orchestrator.createThread({
    title: "Test",
    mode: "work",
    cwd: ".",
    lead: { provider: "claude", model: "opus", effort: "high", access: "ask" },
  });
});

describe("Orchestrator", () => {
  it.live("runs a user turn on the lead and persists everything but deltas", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* Store;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startWorkThread;

      yield* orchestrator.sendUserMessage(lead.id, "hello");
      yield* waitFor((events) =>
        events.find((event) => event.payload._tag === "AgentStateChanged" && event.payload.state === "idle"),
      );

      assert.deepStrictEqual(fake.sessions[0]?.sent, ["hello"]);
      assert.deepStrictEqual(fake.sessions[0]?.options.trustedMcpServers, ["cerium"]);
      assert.include(fake.sessions[0]?.options.appendSystemPrompt ?? "", "lead agent");
      const stored = (yield* store.listEvents(lead.id)).map((event) => event.payload._tag);
      assert.includeMembers(stored, ["SessionStarted", "TurnInput", "MessageCompleted", "TurnCompleted"]);
      assert.notInclude(stored, "MessageDelta");
      const agents = yield* orchestrator.listAgents(lead.threadId);
      assert.strictEqual(agents[0]?.providerSessionId, "fake-1");
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("spawns catalog children with narrowed access and delivers their result to the lead", () => {
    const fake = makeFakeAdapter("claude", {
      reply: (text, session) => (session.model === "haiku" ? "Paris" : `lead saw: ${text}`),
    });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { seen, waitFor } = yield* recordEvents;
      const { lead } = yield* startWorkThread;

      const outcome = yield* orchestrator.spawn(lead.id, {
        role: "scout",
        model: "scout",
        access: "acceptEdits",
        prompt: "Capital of France?",
      });
      assert.strictEqual(outcome._tag, "Spawned");
      const childId = outcome._tag === "Spawned" ? outcome.agentId : ("" as AgentId);

      const child = yield* orchestrator.agent(childId);
      assert.strictEqual(child.access, "ask", "a child never gets more access than its lead");
      assert.strictEqual(child.effort, "low");
      assert.strictEqual(child.parentId, lead.id);

      const [items] = yield* waitFor((events) => {
        const inputs = turnInputs(events, lead.id);
        return inputs.length > 0 ? inputs : undefined;
      });
      assert.deepStrictEqual(items, [
        { _tag: "ChildFinishedTurn", agentId: childId, role: "scout", text: "Paris" },
      ]);
      assert.include(fake.sessions[1]?.sent[0] ?? "", "Capital of France?");
      assert.include(fake.sessions[1]?.options.appendSystemPrompt ?? "", 'role "scout"');
      assert.isTrue(seen.some((event) => event.agentId === lead.id && event.payload._tag === "AgentSpawned"));
    }).pipe(Effect.provide(testLayer([fake.adapter], { catalog: [haiku] })), Effect.scoped);
  });

  it.live("asks the user before spawning a model outside the catalog", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startWorkThread;

      const missing = yield* Effect.exit(
        orchestrator.spawn(lead.id, { role: "x", model: "nope", prompt: "?" }),
      );
      assert.isTrue(Exit.isFailure(missing), "unknown models need a provider so the user can decide");

      const outcome = yield* orchestrator.spawn(lead.id, {
        role: "reviewer",
        model: "sonnet",
        provider: "claude",
        prompt: "Review",
      });
      assert.strictEqual(outcome._tag, "PendingApproval");
      const requestId = outcome._tag === "PendingApproval" ? outcome.requestId : "";
      yield* waitFor((events) => events.find((event) => event.payload._tag === "SpawnApprovalRequested"));

      yield* orchestrator.resolveSpawnApproval(requestId, {
        decision: "allow",
        replacement: { provider: "claude", model: "opus" },
      });
      const spawned = yield* waitFor((events) =>
        events.find((event) => event.payload._tag === "AgentSpawned"),
      );
      assert.deepInclude(spawned.payload, { model: "opus", role: "reviewer" });
      const notice = yield* waitFor((events) =>
        turnInputs(events, lead.id)
          .flat()
          .find((item) => item._tag === "SystemNotice"),
      );
      assert.include(notice._tag === "SystemNotice" ? notice.text : "", "approved");
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("enforces who may spawn, message and kill", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const first = yield* startWorkThread;
      const second = yield* startWorkThread;
      const spawnScout = (leadId: AgentId) =>
        orchestrator
          .spawn(leadId, { role: "scout", model: "scout", prompt: "go" })
          .pipe(Effect.map((outcome) => (outcome._tag === "Spawned" ? outcome.agentId : ("" as AgentId))));
      const child = yield* spawnScout(first.lead.id);
      const otherChild = yield* spawnScout(second.lead.id);

      const reasons = yield* Effect.forEach(
        [
          orchestrator.spawn(child, { role: "x", model: "scout", prompt: "no" }),
          orchestrator.sendMessage(child, second.lead.id, "cross-thread from a child"),
          orchestrator.sendMessage(first.lead.id, otherChild, "into another thread's child"),
          orchestrator.killChild(second.lead.id, child),
        ],
        (attempt) => Effect.flip(attempt).pipe(Effect.map((error) => error.reason)),
      );
      assert.deepStrictEqual(reasons, ["notAllowed", "notAllowed", "notAllowed", "notAllowed"]);

      yield* orchestrator.sendMessage(first.lead.id, second.lead.id, "leads may talk across threads");
      yield* orchestrator.sendMessage(child, first.lead.id, "children may talk to their lead");
      yield* orchestrator.killChild(first.lead.id, child);
      const stopped = (yield* orchestrator.listAgents(first.lead.threadId)).find(
        (agent) => agent.id === child,
      );
      assert.strictEqual(stopped?.state, "stopped");
    }).pipe(Effect.provide(testLayer([fake.adapter], { catalog: [haiku] })), Effect.scoped);
  });

  it.live("stops a pair of agents from exceeding the message budget", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const first = yield* startWorkThread;
      const second = yield* startWorkThread;
      yield* orchestrator.sendMessage(first.lead.id, second.lead.id, "one");
      yield* orchestrator.sendMessage(first.lead.id, second.lead.id, "two");
      const third = yield* Effect.flip(orchestrator.sendMessage(first.lead.id, second.lead.id, "three"));
      assert.strictEqual(third.reason, "budgetExceeded");
      yield* orchestrator.sendMessage(
        second.lead.id,
        first.lead.id,
        "the reverse direction has its own budget",
      );
    }).pipe(Effect.provide(testLayer([fake.adapter], { messageLimit: 2 })), Effect.scoped);
  });

  it.live("never runs more turns at once than the provider allows", () => {
    const fake = makeFakeAdapter("claude", { concurrency: 1, turnDuration: Duration.millis(40) });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const first = yield* startWorkThread;
      const second = yield* startWorkThread;
      yield* orchestrator.sendUserMessage(first.lead.id, "a");
      yield* orchestrator.sendUserMessage(second.lead.id, "b");
      yield* waitFor((events) => {
        const done = events.filter((event) => event.payload._tag === "TurnCompleted");
        return done.length === 2 ? done : undefined;
      });
      assert.strictEqual(fake.running.max, 1);
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("keeps chat threads read-only and requires a folder for work threads", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { lead } = yield* orchestrator.createThread({
        title: "Question",
        mode: "chat",
        lead: { provider: "claude", model: "opus", access: "acceptEdits" },
      });
      assert.strictEqual(lead.access, "readOnly");
      const outcome = yield* orchestrator.spawn(lead.id, { role: "scout", model: "scout", prompt: "?" });
      const child = yield* orchestrator.agent(outcome._tag === "Spawned" ? outcome.agentId : ("" as AgentId));
      assert.strictEqual(child.access, "readOnly");

      const noFolder = yield* Effect.flip(
        orchestrator.createThread({
          title: "Work",
          mode: "work",
          lead: { provider: "claude", model: "opus", access: "ask" },
        }),
      );
      assert.strictEqual(noFolder.reason, "invalid");
    }).pipe(Effect.provide(testLayer([fake.adapter], { catalog: [haiku] })), Effect.scoped);
  });
});
