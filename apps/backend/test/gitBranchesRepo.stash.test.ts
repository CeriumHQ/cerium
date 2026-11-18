import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { GitBranches } from "../src/gitBranches.ts";
import { makeGitBranchesFixture } from "./gitBranchesRepoFixtures.ts";

const { git, sandbox, TestLayer } = makeGitBranchesFixture();

describe("GitBranches stash", () => {
  it.effect("stashes changes with a message, lists them, and applies, pops and drops them", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      assert.deepStrictEqual(yield* branches.stash(root), { unchanged: true });

      yield* box.write(root, "a.txt", "first\n");
      yield* branches.stash(root, { message: "first try" });
      yield* box.write(root, "a.txt", "second\n");
      yield* box.write(root, "extra.txt", "x");
      yield* branches.stash(root, { message: "second try", includeUntracked: true });
      assert.isFalse(yield* box.exists(root, "extra.txt"));
      assert.strictEqual((yield* branches.state(root)).changes, 0);

      const listed = yield* branches.stashes(root);
      assert.deepStrictEqual(
        listed.map((entry) => entry.message),
        ["second try", "first try"],
      );
      assert.strictEqual(listed[0]!.branch, "main");

      yield* branches.stashApply(root, listed[1]!.commit);
      assert.strictEqual(yield* box.read(root, "a.txt"), "first\n");
      assert.lengthOf(yield* branches.stashes(root), 2);
      yield* git(root, "checkout", "--", "a.txt");

      yield* branches.stashApply(root, listed[0]!.commit, true);
      assert.strictEqual(yield* box.read(root, "a.txt"), "second\n");
      assert.isTrue(yield* box.exists(root, "extra.txt"));
      // Popping dropped it by what it was, not by where it was in the list.
      assert.deepStrictEqual(
        (yield* branches.stashes(root)).map((entry) => entry.message),
        ["first try"],
      );

      yield* branches.stashDrop(root, listed[1]!.commit);
      assert.deepStrictEqual(yield* branches.stashes(root), []);
      const gone = yield* branches.stashDrop(root, listed[1]!.commit).pipe(Effect.flip);
      assert.strictEqual(gone.message, "That stash is gone.");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("leaves untracked files alone unless asked", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      yield* box.write(root, "extra.txt", "x");
      assert.deepStrictEqual(yield* branches.stash(root), { unchanged: true });
      assert.isTrue(yield* box.exists(root, "extra.txt"));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("keeps a stash that conflicts when applied, and lists the conflict", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      yield* box.write(root, "a.txt", "stashed\n");
      yield* branches.stash(root);
      yield* box.commit(root, "a.txt", "committed\n");
      const [entry] = yield* branches.stashes(root);
      assert.deepStrictEqual(yield* branches.stashApply(root, entry!.commit, true), { conflicted: true });
      const state = yield* branches.state(root);
      assert.isUndefined(state.operation);
      assert.deepStrictEqual(
        state.conflicts.map((file) => file.path),
        ["a.txt"],
      );
      // A pop that conflicted keeps the stash.
      assert.lengthOf(yield* branches.stashes(root), 1);
      // Nothing new starts until the conflicts are settled.
      const blocked = yield* branches.stash(root).pipe(Effect.flip);
      assert.strictEqual(blocked.message, "Resolve the conflicted files first.");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
