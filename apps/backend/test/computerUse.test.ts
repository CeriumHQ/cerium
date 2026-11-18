import { AGENT_DESKTOP_VERSION, Computer } from "@cerium/computer";
import type { UserSettings } from "@cerium/orchestrator";
import { AgentId, defaultSettings, ThreadId, type ComputerUseStatus } from "@cerium/protocol";
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, FileSystem, Layer, Path, Sink, Stream, SubscriptionRef } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

import { watchComputerUse } from "../src/computerUse.ts";

const settle = (done: () => boolean) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 100 && !done(); turn++) yield* Effect.yieldNow;
  });

const permissionsHarness = () => {
  let permission: "denied" | "granted" | "hanging" = "denied";
  let probes = 0;
  let interrupted = 0;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = command._tag === "StandardCommand" ? command.args : [];
      const [name, subcommand] = args;
      let data: unknown;
      if (name === "version") data = { version: AGENT_DESKTOP_VERSION };
      if (name === "session" && subcommand === "start") data = { session_id: "session" };
      if (name === "permissions") {
        probes++;
        if (permission === "hanging") {
          yield* Effect.addFinalizer(() => Effect.sync(() => void interrupted++));
        }
        data = { accessibility: { state: permission } };
      }
      const hangs = (name === "permissions" && permission === "hanging") || args.includes("batch");
      const stdout = hangs
        ? Stream.never
        : Stream.make(new TextEncoder().encode(JSON.stringify({ ok: true, version: "2.0.0", data })));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(hangs),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout,
        stderr: Stream.empty,
        all: stdout,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  return {
    layer: Computer.layer({ toolsDirectory: "/tools", stateDirectory: "/state" }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
          Path.layer,
        ),
      ),
    ),
    setPermission: (state: typeof permission) => (permission = state),
    probes: () => probes,
    interrupted: () => interrupted,
  };
};

it.effect("keeps session updates live during a shared, bounded permission recheck", () => {
  const helper = permissionsHarness();
  return Effect.gen(function* () {
    const computer = yield* Computer;
    const settings = yield* SubscriptionRef.make(defaultSettings);
    const watch = yield* watchComputerUse(computer, {
      get: SubscriptionRef.get(settings),
      changes: SubscriptionRef.changes(settings),
      update: () => Effect.die("Unexpected settings write"),
    } satisfies UserSettings["Service"]);
    const observe = (updates: Array<ComputerUseStatus>) =>
      watch.pipe(
        Stream.runForEach((status) => Effect.sync(() => void updates.push(status))),
        Effect.forkScoped,
      );
    const first: Array<ComputerUseStatus> = [];
    const second: Array<ComputerUseStatus> = [];
    const initialWatch = yield* observe(first);
    yield* computer.install;
    yield* TestClock.adjust("10 seconds");
    assert.equal(first.at(-1)?.permission, "needed");
    assert.equal(helper.probes(), 1);

    yield* Fiber.interrupt(initialWatch);
    helper.setPermission("hanging");
    yield* SubscriptionRef.update(settings, (current) => ({
      ...current,
      computerUse: { ...current.computerUse, enabled: true },
    }));
    yield* TestClock.adjust("10 seconds");
    assert.equal(helper.probes(), 1);

    yield* observe(first);
    yield* settle(() => helper.probes() > 1);
    assert.equal(helper.probes(), 2);
    yield* observe(second);
    const check = yield* computer.checkPermission.pipe(Effect.forkScoped);
    const caller = { threadId: ThreadId.make("thread"), agentId: AgentId.make("agent"), label: "Agent" };
    yield* computer.read(caller, { command: "snapshot" }).pipe(Effect.ignore, Effect.forkScoped);
    yield* settle(() => [first, second].every((updates) => updates.at(-1)?.sessions[0]?.busy === true));
    assert.equal(helper.probes(), 2);
    assert.isTrue(first.at(-1)?.sessions[0]?.busy);
    assert.isTrue(second.at(-1)?.sessions[0]?.busy);

    yield* computer.stop(caller.threadId);
    yield* settle(() => [first, second].every((updates) => updates.at(-1)?.sessions.length === 0));
    assert.deepEqual(first.at(-1)?.sessions, []);
    assert.deepEqual(second.at(-1)?.sessions, []);
    assert.equal(helper.interrupted(), 0);

    helper.setPermission("granted");
    yield* TestClock.adjust("3 seconds");
    assert.equal(helper.interrupted(), 1);
    assert.isDefined(check.pollUnsafe());
    yield* Fiber.join(check);
    yield* computer.checkPermission;
    assert.equal(helper.probes(), 2);
    yield* TestClock.adjust("3 seconds");
    yield* settle(() => [first, second].every((updates) => updates.at(-1)?.permission === "granted"));
    assert.equal(first.at(-1)?.permission, "granted");
    assert.equal(second.at(-1)?.permission, "granted");
    yield* TestClock.adjust("10 seconds");
    assert.equal(helper.probes(), 3);
  }).pipe(Effect.scoped, Effect.provide(helper.layer));
});
