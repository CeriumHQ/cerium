import type { EventPayload, HarnessStatus } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Stream } from "effect";
import { TestClock } from "effect/testing";

import { HarnessFailure, shareProbe, type AgentSession } from "../src/index.ts";

const signedIn: HarnessStatus = {
  _tag: "HarnessInstalled",
  provider: "claude",
  executablePath: "/bin/claude",
  version: "2.1.310",
  auth: { _tag: "LoggedIn" },
};
const signedOut: HarnessStatus = {
  ...signedIn,
  auth: { _tag: "LoggedOut", loginCommand: "claude auth login" },
};
const missing: HarnessStatus = { _tag: "HarnessMissing", provider: "claude", installHint: "Install it." };

/** A probe that answers each run with the next of `answers` (the last one repeating), counting its runs. */
const scripted = (answers: ReadonlyArray<HarnessStatus | "fails">) => {
  const runs = { count: 0 };
  const probe = Effect.suspend(() => {
    const answer = answers[Math.min(runs.count, answers.length - 1)]!;
    runs.count += 1;
    return answer === "fails"
      ? Effect.fail(new HarnessFailure({ provider: "claude", message: "Could not run it", cause: null }))
      : Effect.succeed(answer);
  });
  return { runs, probe };
};

/** A file system where only `present` exists. */
const files = (present: Set<string>) =>
  FileSystem.makeNoop({ exists: (path) => Effect.succeed(present.has(path)) });

describe("shareProbe", () => {
  it.effect("keeps a probe that found the harness usable, and shares one run between callers", () =>
    Effect.gen(function* () {
      const { runs, probe } = scripted([signedIn]);
      const probes = yield* shareProbe(probe);
      const statuses = yield* Effect.all([probes.kept, probes.kept, probes.kept], {
        concurrency: "unbounded",
      });
      yield* probes.kept;
      assert.deepStrictEqual(statuses, [signedIn, signedIn, signedIn]);
      assert.strictEqual(runs.count, 1);

      // Kept for a while, then probed again.
      yield* TestClock.adjust("4 minutes");
      yield* probes.kept;
      assert.strictEqual(runs.count, 1);
      yield* TestClock.adjust("2 minutes");
      yield* probes.kept;
      assert.strictEqual(runs.count, 2);
    }).pipe(Effect.provideService(FileSystem.FileSystem, files(new Set(["/bin/claude"])))),
  );

  it.effect("keeps nothing else, so a login or an install shows at once", () =>
    Effect.gen(function* () {
      const { runs, probe } = scripted([missing, signedOut, "fails", signedIn]);
      const probes = yield* shareProbe(probe);
      assert.deepStrictEqual(yield* probes.kept, missing);
      assert.deepStrictEqual(yield* probes.kept, signedOut);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(probes.kept)));
      assert.deepStrictEqual(yield* probes.kept, signedIn);
      assert.deepStrictEqual(yield* probes.kept, signedIn);
      assert.strictEqual(runs.count, 4);
    }).pipe(Effect.provideService(FileSystem.FileSystem, files(new Set(["/bin/claude"])))),
  );

  it.effect("probes afresh when asked, and keeps what it found instead", () =>
    Effect.gen(function* () {
      const { runs, probe } = scripted([signedIn, signedOut, signedIn]);
      const probes = yield* shareProbe(probe);
      yield* probes.kept;
      // Signed out since: Check again sees it, and nothing that needs the harness is told otherwise.
      assert.deepStrictEqual(yield* probes.fresh, signedOut);
      assert.deepStrictEqual(yield* probes.kept, signedIn);
      assert.strictEqual(runs.count, 3);
    }).pipe(Effect.provideService(FileSystem.FileSystem, files(new Set(["/bin/claude"])))),
  );

  it.effect("probes again when the kept executable has gone", () =>
    Effect.gen(function* () {
      const present = new Set(["/bin/claude"]);
      const { runs, probe } = scripted([signedIn, missing]);
      const probes = yield* shareProbe(probe).pipe(
        Effect.provideService(FileSystem.FileSystem, files(present)),
      );
      yield* probes.kept;
      present.delete("/bin/claude");
      assert.deepStrictEqual(yield* probes.kept, missing);
      assert.strictEqual(runs.count, 2);
    }),
  );

  it.effect("tells a sign-out a session meets once a turn, and probes anew after it", () =>
    Effect.gen(function* () {
      const { runs, probe } = scripted([signedIn, signedOut]);
      const probes = yield* shareProbe(probe);
      yield* probes.kept;
      const asked: EventPayload = {
        _tag: "AuthRequired",
        provider: "claude",
        reason: "authentication_failed",
        loginCommand: "claude auth login",
      };
      const ended: EventPayload = { _tag: "TurnCompleted", stopReason: "error" };
      const session: AgentSession = {
        events: Stream.fromIterable([asked, asked, ended, asked].map((payload) => ({ payload }))),
        send: () => Effect.void,
        respondToPermission: () => Effect.void,
        interrupt: Effect.void,
        setModel: () => Effect.void,
        setEffort: () => Effect.void,
      };
      const told: EventPayload = {
        _tag: "AgentError",
        kind: "unknown",
        message: "Claude Code is not logged in.",
        retryable: false,
      };
      const events = yield* Stream.runCollect(
        probes.watchSignIn(session, "Claude Code is not logged in.").events,
      );
      assert.deepStrictEqual(
        events.map((event) => event.payload),
        [asked, told, asked, ended, asked, told],
      );
      assert.deepStrictEqual(yield* probes.kept, signedOut);
      assert.strictEqual(runs.count, 2);
    }).pipe(Effect.provideService(FileSystem.FileSystem, files(new Set(["/bin/claude"])))),
  );
});
