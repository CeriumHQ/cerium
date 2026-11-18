import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { GitBranches } from "../src/gitBranches.ts";
import { makeGitBranchesFixture } from "./gitBranchesRepoFixtures.ts";

const { git, sandbox, TestLayer } = makeGitBranchesFixture();

describe("GitBranches switching", () => {
  it.effect("switches to a branch and carries changes that don't collide", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      yield* git(root, "branch", "other");
      yield* box.write(root, "mine.txt", "x");
      yield* branches.switchTo(root, "other", "carry");
      assert.strictEqual((yield* branches.state(root)).branch, "other");
      assert.isTrue(yield* box.exists(root, "mine.txt"));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuses to carry changes that collide, and stashes them on request", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      yield* git(root, "switch", "-q", "-c", "other");
      yield* box.commit(root, "a.txt", "other\n");
      yield* git(root, "switch", "-q", "main");
      yield* box.write(root, "a.txt", "mine\n");
      const refused = yield* branches.switchTo(root, "other", "carry").pipe(Effect.flip);
      assert.include(refused.message, "Commit or stash");
      assert.strictEqual((yield* branches.state(root)).branch, "main");
      yield* branches.switchTo(root, "other", "stash");
      const state = yield* branches.state(root);
      assert.strictEqual(state.branch, "other");
      assert.strictEqual(state.changes, 0);
      const stashes = yield* branches.stashes(root);
      assert.lengthOf(stashes, 1);
      assert.include(stashes[0]!.message, "before switching to other");
      assert.strictEqual(stashes[0]!.branch, "main");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("puts stashed changes back when the switch fails", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      yield* box.write(root, "a.txt", "mine\n");
      const error = yield* branches.switchTo(root, "no-such-branch", "stash").pipe(Effect.flip);
      assert.strictEqual(error.message, "Git doesn't know that branch.");
      assert.strictEqual(yield* box.read(root, "a.txt"), "mine\n");
      assert.deepStrictEqual(yield* branches.stashes(root), []);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("switches to a remote branch by making a local one that follows it", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      const bare = yield* box.remote(root);
      yield* git(root, "push", "-q", "-u", "origin", "main");
      const other = yield* box.clone(bare, "other");
      yield* git(other, "switch", "-q", "-c", "feature");
      yield* box.commit(other, "f.txt", "f\n");
      yield* git(other, "push", "-q", "origin", "feature");
      yield* git(root, "fetch", "-q");
      yield* branches.switchTo(root, "origin/feature");
      const state = yield* branches.state(root);
      assert.strictEqual(state.branch, "feature");
      assert.deepStrictEqual(state.upstream, { name: "origin/feature", ahead: 0, behind: 0, gone: false });
      assert.isTrue(yield* box.exists(root, "f.txt"));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("won't take a branch another worktree has, and says so in plain words", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      const worktree = box.path.join(box.base, "linked");
      yield* git(root, "worktree", "add", "-q", "-b", "side", worktree);
      const list = yield* branches.branches(worktree);
      assert.isDefined(list.local.find((branch) => branch.name === "main")!.checkedOutAt);
      assert.isTrue(list.local.find((branch) => branch.name === "side")!.current);
      const error = yield* branches.switchTo(worktree, "main").pipe(Effect.flip);
      assert.include(error.message, "main is already checked out in another worktree");
      assert.include(error.message, "can't switch to it");
      // Nothing was stashed on the way.
      const stashed = yield* branches.switchTo(worktree, "main", "stash").pipe(Effect.flip);
      assert.include(stashed.message, "another worktree");
      assert.deepStrictEqual(yield* branches.stashes(worktree), []);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuses a name that git would read as an option", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      const error = yield* branches.switchTo(root, "--detach").pipe(Effect.flip);
      assert.strictEqual(error.message, "That isn't a valid branch name.");
      const created = yield* branches.createBranch(root, "-x").pipe(Effect.flip);
      assert.strictEqual(created.message, "That isn't a valid branch name.");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
