import { makeFakeAdapter } from "@cerium/harness/testing";
import type { ThreadWorktree, WorktreeChanges } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Layer, Stream } from "effect";

import {
  Orchestrator,
  ProjectScripts,
  ScriptsError,
  Worktrees,
  WorktreeError,
  type ScriptStarted,
  type TeardownFailure,
} from "../src/index.ts";
import { testLayer } from "./fakes.ts";

/** Scripts that record what was run into `calls`, with the setup `started` says and the teardown `torn` ends with. */
const fakeScripts = (calls: Array<string>, state: { started?: ScriptStarted; torn?: TeardownFailure } = {}) =>
  Layer.succeed(ProjectScripts, {
    resolve: () => Effect.succeed({}),
    start: ({ kind }) =>
      Effect.sync(() => {
        calls.push(`start ${kind}`);
        return state.started;
      }),
    stop: () => Effect.succeed(false),
    status: () => Effect.undefined,
    startAction: () => Effect.fail(new ScriptsError({ message: "No actions here." })),
    writeFile: () => Effect.void,
    ended: Stream.empty,
    served: Stream.empty,
    teardown: ({ cwd }) =>
      Effect.sync(() => {
        calls.push(`teardown ${cwd}`);
        return state.torn;
      }),
    ports: () => Effect.succeed({ first: 20010, last: 20019 }),
  });

/**
 * Worktrees that only record what was asked of them, holding `changes` until told otherwise; a checkout
 * waits for `state.gate` when one is set, and fails with `state.refuseCheckOut`.
 */
const fakeWorktrees = () => {
  const calls: Array<string> = [];
  const state: {
    changes: WorktreeChanges;
    refuse?: string;
    refuseCheckOut?: string;
    gate?: Deferred.Deferred<void>;
  } = { changes: { uncommitted: 0, unmerged: 0 } };
  const layer = Layer.succeed(Worktrees, {
    plan: (project, name) =>
      state.refuse === undefined
        ? Effect.sync(() => {
            calls.push(`plan ${project} ${name}`);
            const worktree: ThreadWorktree = {
              project,
              root: "/worktrees/proj/fix-it",
              branch: "cerium/fix-it",
              base: "main",
            };
            return { worktree, cwd: "/worktrees/proj/fix-it/app" };
          })
        : Effect.fail(new WorktreeError({ message: state.refuse })),
    checkOut: (worktree) =>
      Effect.gen(function* () {
        if (state.gate !== undefined) yield* Deferred.await(state.gate);
        if (state.refuseCheckOut !== undefined) {
          return yield* new WorktreeError({ message: state.refuseCheckOut });
        }
        calls.push(`checkOut ${worktree.branch}`);
        return [".env", "app/.env.local"];
      }),
    changes: () => Effect.succeed(state.changes),
    remove: (threadId, worktree) =>
      Effect.sync(() => void calls.push(`remove ${threadId} ${worktree.branch}`)),
    restore: (worktree) => Effect.sync(() => void calls.push(`restore ${worktree.branch}`)),
  });
  return { calls, state, layer };
};

const start = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator;
  return yield* orchestrator.createThread({
    title: "Fix it",
    mode: "work",
    cwd: "/proj/app",
    worktree: true,
    lead: { provider: "claude", model: "opus", access: "ask" },
  });
});

describe("Orchestrator worktrees", () => {
  it.live("starts a thread's agents in a worktree of its own and tells them its branch", () => {
    const fake = makeFakeAdapter("claude");
    const worktrees = fakeWorktrees();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { thread, lead } = yield* start;
      assert.strictEqual(thread.cwd, "/worktrees/proj/fix-it/app");
      assert.strictEqual(thread.worktree?.project, "/proj/app");
      assert.deepStrictEqual(worktrees.calls, ["plan /proj/app Fix it"]);

      yield* orchestrator.sendUserMessage(lead.id, "hello");
      while (fake.sessions[0] === undefined) yield* Effect.sleep("5 millis");
      assert.strictEqual(fake.sessions[0].options.cwd, "/worktrees/proj/fix-it/app");
      assert.include(fake.sessions[0].options.appendSystemPrompt ?? "", "branch `cerium/fix-it`");
    }).pipe(Effect.provide(testLayer([fake.adapter], { worktrees: worktrees.layer })), Effect.scoped);
  });

  it.live("starts a lead's threads from its project, in worktrees of their own like its thread", () => {
    const fake = makeFakeAdapter("claude");
    const worktrees = fakeWorktrees();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { lead } = yield* start;
      const isolated = yield* orchestrator.startThread(lead.id, { prompt: "Dark mode", title: "Dark mode" });
      assert.strictEqual(isolated.thread.worktree?.project, "/proj/app");
      const shared = yield* orchestrator.startThread(lead.id, { prompt: "Docs", worktree: false });
      assert.strictEqual(shared.thread.cwd, "/proj/app");
      assert.isUndefined(shared.thread.worktree);
      assert.deepStrictEqual(
        worktrees.calls.filter((call) => call.startsWith("plan")),
        ["plan /proj/app Fix it", "plan /proj/app Dark mode"],
      );
    }).pipe(Effect.provide(testLayer([fake.adapter], { worktrees: worktrees.layer })), Effect.scoped);
  });

  it.live("shows the thread before its worktree is checked out, its session waiting for it", () => {
    const fake = makeFakeAdapter("claude");
    const worktrees = fakeWorktrees();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const gate = yield* Deferred.make<void>();
      worktrees.state.gate = gate;
      const { thread, lead } = yield* start;
      assert.deepStrictEqual(
        (yield* orchestrator.listThreads).map(({ id }) => id),
        [thread.id],
      );
      // The message is taken at once; the harness starts only once the folder is there.
      yield* orchestrator.sendUserMessage(lead.id, "hello");
      yield* Effect.sleep("50 millis");
      assert.strictEqual(fake.sessions.length, 0);
      yield* Deferred.succeed(gate, undefined);
      while (fake.sessions[0]?.sent[0] === undefined) yield* Effect.sleep("5 millis");
      assert.include(worktrees.calls, "checkOut cerium/fix-it");
      const heard = fake.sessions[0].sent.join("\n");
      assert.include(heard, "hello");
      assert.include(heard, "Copied from the project into this worktree");
    }).pipe(Effect.provide(testLayer([fake.adapter], { worktrees: worktrees.layer })), Effect.scoped);
  });

  it.live("tells in the thread why its worktree couldn't be checked out", () => {
    const fake = makeFakeAdapter("claude");
    const worktrees = fakeWorktrees();
    worktrees.state.refuseCheckOut = "invalid reference: main";
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { thread } = yield* start;
      let lead = (yield* orchestrator.listAgents(thread.id))[0];
      while (lead?.state !== "failed") {
        yield* Effect.sleep("5 millis");
        lead = (yield* orchestrator.listAgents(thread.id))[0];
      }
      assert.strictEqual(fake.sessions.length, 0);
      const events = yield* orchestrator.threadEvents(thread.id);
      assert.include(JSON.stringify(events), "Couldn't make the thread's worktree: invalid reference: main");
    }).pipe(Effect.provide(testLayer([fake.adapter], { worktrees: worktrees.layer })), Effect.scoped);
  });

  it.live("refuses a thread whose worktree can't be made, with git's reason", () => {
    const worktrees = fakeWorktrees();
    worktrees.state.refuse = "/proj/app isn't in a git repository.";
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(start);
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "isn't in a git repository");
      assert.deepStrictEqual(yield* (yield* Orchestrator).listThreads, []);
    }).pipe(
      Effect.provide(testLayer([makeFakeAdapter("claude").adapter], { worktrees: worktrees.layer })),
      Effect.scoped,
    );
  });

  it.live("asks before archiving unmerged work, removes the worktree, and puts it back on restore", () => {
    const fake = makeFakeAdapter("claude");
    const worktrees = fakeWorktrees();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { thread } = yield* start;
      worktrees.state.changes = { uncommitted: 2, unmerged: 1 };
      assert.deepStrictEqual(yield* orchestrator.worktreeChanges(thread.id), worktrees.state.changes);

      const refused = yield* Effect.exit(orchestrator.setThreadArchived(thread.id, true));
      assert.isTrue(Exit.isFailure(refused));
      assert.include(String(refused), "2 uncommitted changes and 1 commit not merged into main");
      assert.notInclude(worktrees.calls.join("\n"), "remove");

      const archived = yield* orchestrator.setThreadArchived(thread.id, true, { discardWork: true });
      assert.isDefined(archived.archivedAt);
      assert.include(worktrees.calls, `remove ${thread.id} cerium/fix-it`);
      // Its sessions ended with the folder they ran in.
      const [lead] = yield* orchestrator.listAgents(thread.id);
      assert.strictEqual(lead?.state, "stopped");
      // A lead can't pick up a thread whose folder is gone.
      assert.isTrue(Exit.isFailure(yield* Effect.exit(orchestrator.sendUserMessage(lead!.id, "more"))));

      const restored = yield* orchestrator.setThreadArchived(thread.id, false);
      assert.isUndefined(restored.archivedAt);
      assert.include(worktrees.calls, "restore cerium/fix-it");
    }).pipe(Effect.provide(testLayer([fake.adapter], { worktrees: worktrees.layer })), Effect.scoped);
  });

  it.live(
    "runs the teardown in the worktree before removing it, and puts the thread away when it fails",
    () => {
      const worktrees = fakeWorktrees();
      const torn: TeardownFailure = { script: "docker compose down", failure: "exited with code 1" };
      const scripts = fakeScripts(worktrees.calls, { torn });
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator;
        const { thread } = yield* start;
        const told: Array<TeardownFailure> = [];
        const archived = yield* orchestrator.setThreadArchived(thread.id, true, {
          onTeardownFailed: (failure) => void told.push(failure),
        });
        assert.isDefined(archived.archivedAt);
        assert.deepStrictEqual(told, [torn]);
        const ran = worktrees.calls.filter((call) => /^(teardown|remove)/.test(call));
        assert.deepStrictEqual(ran, [
          "teardown /worktrees/proj/fix-it/app",
          `remove ${thread.id} cerium/fix-it`,
        ]);

        // Deleting a live thread runs it too; an archived thread's worktree is gone, so it doesn't.
        const second = yield* start;
        yield* orchestrator.deleteThread(second.thread.id, {
          onTeardownFailed: (failure) => void told.push(failure),
        });
        assert.strictEqual(told.length, 2);
        const before = worktrees.calls.filter((call) => call.startsWith("teardown")).length;
        yield* orchestrator.deleteThread(thread.id);
        assert.strictEqual(worktrees.calls.filter((call) => call.startsWith("teardown")).length, before);
      }).pipe(
        Effect.provide(
          testLayer([makeFakeAdapter("claude").adapter], { worktrees: worktrees.layer, scripts }),
        ),
        Effect.scoped,
      );
    },
  );

  it.live("keeps a refused archive from running the teardown", () => {
    const worktrees = fakeWorktrees();
    const scripts = fakeScripts(worktrees.calls);
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { thread } = yield* start;
      worktrees.state.changes = { uncommitted: 1, unmerged: 0 };
      assert.isTrue(Exit.isFailure(yield* Effect.exit(orchestrator.setThreadArchived(thread.id, true))));
      assert.notInclude(worktrees.calls.join("\n"), "teardown");
    }).pipe(
      Effect.provide(testLayer([makeFakeAdapter("claude").adapter], { worktrees: worktrees.layer, scripts })),
      Effect.scoped,
    );
  });

  it.live("tells the lead its ports, and that a guessed setup waits on the user's word in the thread", () => {
    const fake = makeFakeAdapter("claude");
    const worktrees = fakeWorktrees();
    const scripts = fakeScripts(worktrees.calls, { started: { _tag: "Guess", script: "bun install" } });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { lead } = yield* start;
      yield* orchestrator.sendUserMessage(lead.id, "hello");
      while (fake.sessions[0]?.sent[0] === undefined) yield* Effect.sleep("5 millis");
      const heard = fake.sessions[0].sent.join("\n");
      assert.include(heard, "`bun install`");
      assert.include(heard, "the user was asked in this thread");
      assert.notInclude(heard, "Settings");
      assert.include(heard, "20010–20019");
      assert.include(heard, "CERIUM_PORT");
      assert.include(
        heard,
        "Copied from the project into this worktree, since git ignores them: `.env`, `app/.env.local`.",
      );
    }).pipe(
      Effect.provide(testLayer([fake.adapter], { worktrees: worktrees.layer, scripts })),
      Effect.scoped,
    );
  });

  it.live("archives a worktree with nothing unmerged without asking", () => {
    const worktrees = fakeWorktrees();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { thread } = yield* start;
      yield* orchestrator.setThreadArchived(thread.id, true);
      assert.include(worktrees.calls, `remove ${thread.id} cerium/fix-it`);
    }).pipe(
      Effect.provide(testLayer([makeFakeAdapter("claude").adapter], { worktrees: worktrees.layer })),
      Effect.scoped,
    );
  });

  it.live("removes the worktree of a thread deleted for good, and leaves an archived one's alone", () => {
    const worktrees = fakeWorktrees();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const first = yield* start;
      worktrees.state.changes = { uncommitted: 1, unmerged: 0 };
      assert.isTrue(Exit.isFailure(yield* Effect.exit(orchestrator.deleteThread(first.thread.id))));
      yield* orchestrator.deleteThread(first.thread.id, { discardWork: true });
      assert.include(worktrees.calls, `remove ${first.thread.id} cerium/fix-it`);

      worktrees.state.changes = { uncommitted: 0, unmerged: 0 };
      const second = yield* start;
      yield* orchestrator.setThreadArchived(second.thread.id, true);
      const removals = worktrees.calls.filter((call) => call.startsWith("remove")).length;
      yield* orchestrator.deleteThread(second.thread.id);
      assert.strictEqual(worktrees.calls.filter((call) => call.startsWith("remove")).length, removals);
    }).pipe(
      Effect.provide(testLayer([makeFakeAdapter("claude").adapter], { worktrees: worktrees.layer })),
      Effect.scoped,
    );
  });
});
