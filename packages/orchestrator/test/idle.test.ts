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
    yield* waitFor(() => (fake.sessions[1]?.sent.length ? true : undefined));
    assert.strictEqual(fake.sessions[1]?.options.resume, "fake-1");
    assert.include(fake.sessions[1]?.sent[0] ?? "", "delayed report");
  }).pipe(
    Effect.provide(testLayer([adapter], { idleSessionTTL: Duration.millis(60), warmSessions: 0 })),
    Effect.scoped,
  );
});
