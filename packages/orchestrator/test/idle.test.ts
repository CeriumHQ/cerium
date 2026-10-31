import type { AgentId } from "@cerium/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, it } from "@effect/vitest";
import { makeFakeAdapter } from "@cerium/harness/testing";
import { Duration, Effect } from "effect";
import { Orchestrator } from "../src/index.ts";
import { recordEvents, testLayer } from "./fakes.ts";

it.live("keeps a host alive while its turn waits for a permission answer", () => {
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
    const { waitFor } = yield* recordEvents;
    const { lead } = yield* orchestrator.createThread({
      title: "Approval",
      mode: "work",
      cwd: ".",
      lead: { provider: "claude", model: "opus", access: "ask" },
    });
    yield* orchestrator.sendUserMessage(lead.id, "work");
    yield* waitFor((events) => events.find((event) => event.payload._tag === "PermissionRequested"));
    yield* Effect.sleep("150 millis");
    assert.isFalse(closed);
    assert.isTrue(orchestrator.awaitingApproval(lead.threadId));
  }).pipe(
    Effect.provide(testLayer([adapter], { idleSessionTTL: Duration.millis(20), warmSessions: 0 })),
    Effect.scoped,
  );
});

it.live("hibernates an idle host without stopping its agent and resumes its session for a notice", () => {
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
    const { waitFor } = yield* recordEvents;
    const { lead } = yield* orchestrator.createThread({
      title: "Idle",
      mode: "work",
      cwd: ".",
      lead: { provider: "claude", model: "opus", access: "readOnly" },
    });
    yield* orchestrator.sendUserMessage(lead.id, "first");
    yield* waitFor(() => (closed.includes(0) ? true : undefined));
    assert.strictEqual((yield* orchestrator.listAgents(lead.threadId))[0]?.state, "idle");
    yield* orchestrator.notify(lead.id, "delayed report");
    yield* Effect.sleep("100 millis");
    assert.lengthOf(fake.sessions, 1, "an informational notice does not resume the host");
    yield* orchestrator.wake(lead.id, "action required");
    yield* waitFor(() => (fake.sessions[1]?.sent.length ? true : undefined));
    assert.strictEqual(fake.sessions[1]?.options.resume, "fake-1");
    assert.strictEqual(
      fake.sessions[1]?.options.appendSystemPrompt,
      fake.sessions[0]?.options.appendSystemPrompt,
      "resuming preserves the instruction prefix",
    );
    assert.include(fake.sessions[1]?.sent[0] ?? "", "delayed report");
  }).pipe(
    Effect.provide(testLayer([adapter], { idleSessionTTL: Duration.millis(60), warmSessions: 0 })),
    Effect.scoped,
  );
});

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
