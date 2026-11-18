import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { GitBranches } from "../src/gitBranches.ts";
import { makeGitBranchesFixture } from "./gitBranchesRepoFixtures.ts";

const { git, sandbox, TestLayer } = makeGitBranchesFixture();

describe("GitBranches syncing", () => {
  it.effect("publishes a branch, then pushes, fetches and pulls", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      const bare = yield* box.remote(root);
      // A branch that follows nothing can't be pushed, only published.
      const unpublished = yield* branches.push(root).pipe(Effect.flip);
      assert.include(unpublished.message, "Publish");
      yield* branches.push(root, "publish");
      assert.deepStrictEqual((yield* branches.state(root)).upstream, {
        name: "origin/main",
        ahead: 0,
        behind: 0,
        gone: false,
      });
      assert.deepStrictEqual(yield* branches.push(root), { unchanged: true });
      yield* box.commit(root, "mine.txt", "mine\n", "mine");
      assert.strictEqual((yield* branches.state(root)).upstream?.ahead, 1);
      yield* branches.push(root);
      assert.strictEqual((yield* branches.state(root)).upstream?.ahead, 0);

      const other = yield* box.clone(bare, "other");
      yield* box.commit(other, "theirs.txt", "theirs\n", "theirs");
      yield* git(other, "push", "-q");
      // Unfetched, the remote's new commit isn't known; fetching shows it.
      assert.strictEqual((yield* branches.state(root)).upstream?.behind, 0);
      assert.deepStrictEqual(yield* branches.fetch(root), {});
      assert.strictEqual((yield* branches.state(root)).upstream?.behind, 1);
      assert.deepStrictEqual(yield* branches.fetch(root), { unchanged: true });
      assert.deepStrictEqual(yield* branches.fetch(root, true), { unchanged: true });
      assert.deepStrictEqual(yield* branches.pull(root), {});
      assert.isTrue(yield* box.exists(root, "theirs.txt"));
      const state = yield* branches.state(root);
      assert.deepStrictEqual([state.upstream?.ahead, state.upstream?.behind], [0, 0]);
      assert.deepStrictEqual(yield* branches.pull(root), { unchanged: true });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "says a push is rejected until the branch is pulled, and merges diverged branches by default",
    () =>
      Effect.gen(function* () {
        const branches = yield* GitBranches;
        const box = yield* sandbox;
        const root = yield* box.init("repo");
        const bare = yield* box.remote(root);
        yield* branches.push(root, "publish");
        const other = yield* box.clone(bare, "other");
        yield* box.commit(other, "theirs.txt", "theirs\n", "theirs");
        yield* git(other, "push", "-q");
        yield* box.commit(root, "mine.txt", "mine\n", "mine");
        const rejected = yield* branches.push(root).pipe(Effect.flip);
        assert.strictEqual(
          rejected.message,
          "The remote has commits you don't have yet. Pull first, then push again.",
        );
        // Git's own default for diverged branches is to ask; Cerium merges, as git always did.
        assert.deepStrictEqual(yield* branches.pull(root), {});
        const state = yield* branches.state(root);
        assert.deepStrictEqual([state.upstream?.ahead, state.upstream?.behind], [2, 0]);
        yield* branches.push(root);
        assert.strictEqual((yield* branches.state(root)).upstream?.ahead, 0);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("pulls by rebasing when the user's configuration says so", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      const bare = yield* box.remote(root);
      yield* branches.push(root, "publish");
      yield* git(root, "config", "pull.rebase", "true");
      const other = yield* box.clone(bare, "other");
      yield* box.commit(other, "theirs.txt", "theirs\n", "theirs");
      yield* git(other, "push", "-q");
      yield* box.commit(root, "mine.txt", "mine\n", "mine");
      assert.deepStrictEqual(yield* branches.pull(root), {});
      // A rebase leaves a straight line: no merge commit.
      assert.strictEqual((yield* git(root, "rev-list", "--merges", "--count", "HEAD")).trim(), "0");
      assert.strictEqual((yield* branches.state(root)).upstream?.ahead, 1);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("overwrites the remote branch only with a lease", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      const bare = yield* box.remote(root);
      yield* branches.push(root, "publish");
      yield* git(root, "commit", "-q", "--amend", "-m", "rewritten");
      const rejected = yield* branches.push(root).pipe(Effect.flip);
      assert.include(rejected.message, "Pull first");
      yield* branches.push(root, "forceWithLease");
      assert.strictEqual((yield* git(bare, "log", "-1", "--format=%s", "main")).trim(), "rewritten");
      // Someone else pushes; a lease taken before knowing of it fails.
      const other = yield* box.clone(bare, "other");
      yield* box.commit(other, "theirs.txt", "theirs\n", "theirs");
      yield* git(other, "push", "-q");
      yield* git(root, "commit", "-q", "--amend", "-m", "rewritten again");
      const stale = yield* branches.push(root, "forceWithLease").pipe(Effect.flip);
      assert.include(stale.message, "Fetch");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("says what is missing when there is nothing to sync with", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      const noRemote = yield* branches.fetch(root).pipe(Effect.flip);
      assert.strictEqual(noRemote.message, "This repository has no remote to fetch from.");
      assert.deepStrictEqual(yield* branches.fetch(root, true), { unchanged: true });
      const published = yield* branches.push(root, "publish").pipe(Effect.flip);
      assert.include(published.message, "no remote");
      const pulled = yield* branches.pull(root).pipe(Effect.flip);
      assert.include(pulled.message, "Publish");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("can't reach a remote that isn't there, and says so in one line", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      yield* git(root, "remote", "add", "origin", box.path.join(box.base, "missing.git"));
      const error = yield* branches.fetch(root).pipe(Effect.flip);
      assert.isAbove(error.message.length, 0);
      assert.notInclude(error.message, "\n");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
