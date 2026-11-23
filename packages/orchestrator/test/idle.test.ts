import type { AgentId } from "@cerium/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import { makeFakeAdapter } from "@cerium/harness/testing";
import { Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { Orchestrator } from "../src/index.ts";
import { recordEvents, testLayer } from "./fakes.ts";

it.effect("keeps an expired warm host alive until its permission request and turn finish", () => {
  const fake = makeFakeAdapter("claude", { askPermission: true });
  let closed = false;
  const adapter = {
    ...fake.adapter,
    startSession: (options: Parameters<typeof fake.adapter.startSession>[0]) =>
      fake.adapter.startSession(options).pipe(
        Effect.tap(() =>
          Effect.addFinalizer(() =>
            Effect.sync(() => {
              closed = true;
            }),
          ),
        ),
      ),
  };
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    const { lead } = yield* orchestrator.createThread({
      title: "Approval",
      mode: "work",
      cwd: ".",
      lead: { provider: "claude", model: "opus", access: "ask" },
    });
    yield* orchestrator.sendUserMessage(lead.id, "work");
    yield* TestClock.adjust("31 minutes");
    assert.isFalse(closed);
    assert.isTrue(orchestrator.awaitingApproval(lead.threadId));
    yield* orchestrator.respondToPermission(lead.id, "p1", { decision: "allow", scope: "once" });
    yield* TestClock.adjust("2 minutes");
    assert.isTrue(closed);
    assert.strictEqual((yield* orchestrator.agent(lead.id)).state, "idle");
  }).pipe(Effect.provide(testLayer([adapter])), Effect.scoped);
});

it.effect("retires excess idle hosts first and expires the latest four even after recent use", () => {
  const fake = makeFakeAdapter("claude");
  const closed: number[] = [];
  const adapter = {
    ...fake.adapter,
    startSession: (options: Parameters<typeof fake.adapter.startSession>[0]) =>
      Effect.gen(function* () {
        const session = yield* fake.adapter.startSession(options);
        const index = fake.sessions.length - 1;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed.push(index);
          }),
        );
        return session;
      }),
  };
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    const agents: AgentId[] = [];
    for (let index = 0; index < 5; index++) {
      const { lead } = yield* orchestrator.createThread({
        title: `Idle ${index}`,
        mode: "chat",
        lead: { provider: "claude", model: "opus", access: "readOnly" },
      });
      agents.push(lead.id);
      yield* orchestrator.sendUserMessage(lead.id, "first");
      yield* TestClock.adjust("1 minute");
    }
    yield* TestClock.adjust("2 minutes");
    assert.deepStrictEqual(closed, [0]);

    yield* TestClock.adjust("21 minutes");
    const recentlyUsed = agents[1]!;
    yield* orchestrator.sendUserMessage(recentlyUsed, "keep working");
    yield* TestClock.adjust("1 minute");
    assert.lengthOf(fake.sessions[1]!.sent, 2);
    assert.deepStrictEqual(closed, [0]);

    yield* TestClock.adjust("3 minutes");
    assert.include(closed, 1, "a recent turn does not extend the host's deadline");
    yield* TestClock.adjust("4 minutes");
    assert.sameMembers(closed, [0, 1, 2, 3, 4]);
    assert.strictEqual((yield* orchestrator.agent(recentlyUsed)).state, "idle");

    yield* orchestrator.notify(recentlyUsed, "delayed report");
    yield* TestClock.adjust("1 minute");
    assert.lengthOf(fake.sessions, 5, "an informational notice does not resume the host");
    yield* orchestrator.wake(recentlyUsed, "action required");
    yield* TestClock.adjust("1 minute");
    assert.strictEqual(fake.sessions[5]?.options.resume, "fake-2");
    assert.strictEqual(
      fake.sessions[5]?.options.appendSystemPrompt,
      fake.sessions[1]?.options.appendSystemPrompt,
      "resuming preserves the instruction prefix",
    );
    assert.include(fake.sessions[5]?.sent[0] ?? "", "delayed report");
    yield* TestClock.adjust("6 minutes");
    assert.lengthOf(closed, 5, "the resumed host starts a new deadline");
  }).pipe(Effect.provide(testLayer([adapter])), Effect.scoped);
});

it.effect("reserves warm slots for leads and fully stops free children even without resume support", () => {
  const leads = makeFakeAdapter("claude");
  const other = makeFakeAdapter("codex");
  const adapter = {
    ...other.adapter,
    manifest: { ...other.adapter.manifest, session: { ...other.adapter.manifest.session, resume: false } },
  };
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    const thread = (title: string) =>
      orchestrator.createThread({
        title,
        mode: "chat",
        lead: { provider: "claude", model: "opus", access: "readOnly" },
      });
    const earlier = yield* thread("First");
    yield* orchestrator.sendUserMessage(earlier.lead.id, "hello");
    yield* TestClock.adjust("50 millis");
    const { lead } = yield* thread("Team");
    for (const model of ["worker", "other"]) {
      yield* orchestrator.spawn(lead.id, { model, role: model, prompt: "go" });
    }
    yield* TestClock.adjust("300 millis");
    const team = () =>
      orchestrator
        .listAgents(lead.threadId)
        .pipe(Effect.map((agents) => agents.filter((a) => a.parentId === lead.id)));
    assert.deepStrictEqual(
      (yield* team()).map((a) => a.state),
      ["idle", "idle"],
    );
    yield* orchestrator.sendUserMessage(earlier.lead.id, "again");
    yield* TestClock.adjust("100 millis");
    assert.lengthOf(leads.sessions, 3, "the older lead still has its original host");
    assert.lengthOf(leads.sessions[0]!.sent, 2);
    yield* TestClock.adjust("800 millis");
    assert.deepStrictEqual(
      (yield* team()).map((a) => a.state),
      ["stopped", "stopped"],
    );
    assert.lengthOf(leads.sessions[1]!.sent, 1, "idle cleanup does not wake the parent");
  }).pipe(
    Effect.provide(
      testLayer([leads.adapter, adapter], {
        catalog: [
          { alias: "worker", provider: "claude", model: "haiku", description: "Worker" },
          { alias: "other", provider: "codex", model: "gpt", description: "Worker" },
        ],
        idleSessionTTL: Duration.millis(100),
        childIdleTTL: Duration.seconds(1),
        warmSessions: 2,
      }),
    ),
    Effect.scoped,
  );
});

it.effect(
  "retires prior idle children after a user turn and preserves the one continued in that turn",
  () => {
    const fake = makeFakeAdapter("claude", { turnDuration: "100 millis" });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { lead } = yield* orchestrator.createThread({
        title: "Work",
        mode: "chat",
        lead: { provider: "claude", model: "opus", access: "readOnly" },
      });
      yield* orchestrator.sendUserMessage(lead.id, "parallel work");
      yield* TestClock.adjust("10 millis");
      const spawn = (role: string) => orchestrator.spawn(lead.id, { model: "worker", role, prompt: "go" });
      const one = yield* spawn("scout");
      const two = yield* spawn("writer");
      if (one._tag !== "Spawned" || two._tag !== "Spawned") throw new Error("Expected children");
      yield* TestClock.adjust("500 millis");
      assert.strictEqual((yield* orchestrator.agent(one.agentId)).state, "idle");
      assert.strictEqual((yield* orchestrator.agent(two.agentId)).state, "idle");
      yield* orchestrator.sendUserMessage(lead.id, "follow up");
      yield* TestClock.adjust("10 millis");
      yield* orchestrator.continueChild(lead.id, two.agentId, "check another file");
      yield* TestClock.adjust("500 millis");
      const agents = yield* orchestrator.listAgents(lead.threadId);
      assert.strictEqual(agents.find((a) => a.id === one.agentId)?.state, "stopped");
      assert.strictEqual(agents.find((a) => a.id === two.agentId)?.state, "idle");
    }).pipe(
      Effect.provide(
        testLayer([fake.adapter], {
          catalog: [{ alias: "worker", provider: "claude", model: "haiku", description: "Worker" }],
        }),
      ),
      Effect.scoped,
    );
  },
);

it.effect(
  "keeps a finished child alive while a sibling is still working, then retires both once idle",
  () => {
    const fast = makeFakeAdapter("claude", { turnDuration: "50 millis" });
    const slow = makeFakeAdapter("codex", { turnDuration: "1500 millis" });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { lead } = yield* orchestrator.createThread({
        title: "Wave",
        mode: "chat",
        lead: { provider: "claude", model: "opus", access: "readOnly" },
      });
      yield* orchestrator.sendUserMessage(lead.id, "parallel work");
      yield* TestClock.adjust("10 millis");
      const first = yield* orchestrator.spawn(lead.id, { model: "fast", role: "fast", prompt: "quick" });
      const second = yield* orchestrator.spawn(lead.id, { model: "slow", role: "slow", prompt: "long" });
      if (first._tag !== "Spawned" || second._tag !== "Spawned") throw new Error("Expected children");
      yield* TestClock.adjust("900 millis");
      assert.strictEqual((yield* orchestrator.agent(first.agentId)).state, "idle");
      assert.strictEqual((yield* orchestrator.agent(second.agentId)).state, "running");
      yield* TestClock.adjust("1000 millis");
      assert.strictEqual((yield* orchestrator.agent(first.agentId)).state, "idle");
      assert.strictEqual((yield* orchestrator.agent(second.agentId)).state, "idle");
      yield* TestClock.adjust("600 millis");
      const agents = yield* orchestrator.listAgents(lead.threadId);
      assert.strictEqual(agents.find((a) => a.id === first.agentId)?.state, "stopped");
      assert.strictEqual(agents.find((a) => a.id === second.agentId)?.state, "stopped");
    }).pipe(
      Effect.provide(
        testLayer([fast.adapter, slow.adapter], {
          catalog: [
            { alias: "fast", provider: "claude", model: "haiku", description: "Fast" },
            { alias: "slow", provider: "codex", model: "gpt", description: "Slow" },
          ],
          childIdleTTL: Duration.millis(500),
        }),
      ),
      Effect.scoped,
    );
  },
);

it.live("wakes a host that slept before its first turn on a new session, not the one it never saved", () => {
  const fake = makeFakeAdapter("codex");
  const closed: number[] = [];
  const adapter = {
    ...fake.adapter,
    startSession: (options: Parameters<typeof fake.adapter.startSession>[0]) =>
      Effect.gen(function* () {
        const session = yield* fake.adapter.startSession(options);
        const index = fake.sessions.length - 1;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed.push(index);
          }),
        );
        return session;
      }),
  };
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    const { waitFor } = yield* recordEvents;
    const { lead } = yield* orchestrator.createThread({
      title: "Moved",
      mode: "work",
      cwd: ".",
      lead: { provider: "codex", model: "gpt", access: "readOnly" },
    });
    yield* waitFor(() => (closed.includes(0) ? true : undefined));
    yield* orchestrator.sendUserMessage(lead.id, "so what are we waiting for");
    yield* waitFor(() => (fake.sessions[1]?.sent.length ? true : undefined));
    assert.isUndefined(fake.sessions[1]?.options.resume);
    assert.include(fake.sessions[1]?.sent[0] ?? "", "so what are we waiting for");
  }).pipe(
    Effect.provide(testLayer([adapter], { idleSessionTTL: Duration.millis(60), warmSessions: 0 })),
    Effect.scoped,
  );
});

it.live("retains quiet notices over a backend restart and delivers each once", () => {
  const fake = makeFakeAdapter("claude");
  const database = join(mkdtempSync(join(tmpdir(), "cerium-notices-")), "store.db");
  let agentId: AgentId;
  const first = Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    const { waitFor } = yield* recordEvents;
    const { lead } = yield* orchestrator.createThread({
      title: "CI",
      mode: "work",
      cwd: ".",
      lead: { provider: "claude", model: "opus", access: "readOnly" },
    });
    agentId = lead.id;
    yield* orchestrator.sendUserMessage(lead.id, "first");
    yield* waitFor((events) =>
      events.find((e) => e.agentId === lead.id && e.payload._tag === "TurnCompleted"),
    );
    yield* orchestrator.notify(lead.id, "CI passed");
    yield* Effect.sleep("50 millis");
    assert.lengthOf(fake.sessions[0]!.sent, 1);
  }).pipe(Effect.provide(testLayer([fake.adapter], { database })), Effect.scoped);
  const resume = (index: number) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      yield* orchestrator.sendUserMessage(agentId, "continue");
      yield* waitFor(() => (fake.sessions[index]?.sent.length ? true : undefined));
      const sent = fake.sessions[index]!.sent[0]!;
      if (index === 1) assert.include(sent, "CI passed");
      else assert.notInclude(sent, "CI passed");
    }).pipe(Effect.provide(testLayer([fake.adapter], { database })), Effect.scoped);
  return first.pipe(Effect.andThen(resume(1)), Effect.andThen(resume(2)));
});
