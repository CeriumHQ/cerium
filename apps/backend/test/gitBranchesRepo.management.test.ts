import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { GitBranches } from "../src/gitBranches.ts";
import { makeGitBranchesFixture } from "./gitBranchesRepoFixtures.ts";

const { git, sandbox, TestLayer } = makeGitBranchesFixture();

describe("GitBranches branch management", () => {
  it.effect("makes a branch at the current commit and switches to it", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      yield* box.write(root, "wip.txt", "x");
      yield* branches.createBranch(root, "topic");
      const state = yield* branches.state(root);
      assert.strictEqual(state.branch, "topic");
      assert.isUndefined(state.upstream);
      assert.strictEqual(state.changes, 1);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "makes a branch from another one without switching, and from a remote one without following it",
    () =>
      Effect.gen(function* () {
        const branches = yield* GitBranches;
        const box = yield* sandbox;
        const root = yield* box.init("repo");
        yield* box.remote(root);
        yield* git(root, "push", "-q", "-u", "origin", "main");
        yield* git(root, "switch", "-q", "-c", "base-branch");
        yield* box.commit(root, "b.txt", "b\n");
        yield* git(root, "switch", "-q", "main");
        yield* branches.createBranch(root, "off-base", { from: "base-branch", switch: false });
        assert.strictEqual((yield* branches.state(root)).branch, "main");
        assert.strictEqual(
          yield* git(root, "rev-parse", "off-base"),
          yield* git(root, "rev-parse", "base-branch"),
        );
        yield* branches.createBranch(root, "off-remote", { from: "origin/main" });
        const state = yield* branches.state(root);
        assert.strictEqual(state.branch, "off-remote");
        assert.isUndefined(state.upstream);
        const exists = yield* branches.createBranch(root, "main").pipe(Effect.flip);
        assert.strictEqual(exists.message, "A branch named main already exists.");
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("renames a branch", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      yield* git(root, "branch", "old");
      yield* branches.renameBranch(root, "old", "new");
      const names = (yield* branches.branches(root)).local.map((branch) => branch.name).toSorted();
      assert.deepStrictEqual(names, ["main", "new"]);
      const invalid = yield* branches.renameBranch(root, "new", "a b").pipe(Effect.flip);
      assert.strictEqual(invalid.message, "That isn't a valid branch name.");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("deletes a merged branch, and asks before deleting one with commits only it has", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      yield* git(root, "branch", "merged");
      yield* git(root, "switch", "-q", "-c", "unmerged");
      yield* box.commit(root, "u.txt", "1\n", "one");
      yield* box.commit(root, "u.txt", "2\n", "two");
      yield* git(root, "switch", "-q", "main");
      assert.deepStrictEqual(yield* branches.deleteBranch(root, "merged"), { _tag: "Deleted" });
      assert.deepStrictEqual(yield* branches.deleteBranch(root, "unmerged"), {
        _tag: "Unmerged",
        commits: 2,
      });
      assert.include(
        (yield* branches.branches(root)).local.map((branch) => branch.name),
        "unmerged",
      );
      assert.deepStrictEqual(yield* branches.deleteBranch(root, "unmerged", true), { _tag: "Deleted" });
      assert.deepStrictEqual(
        (yield* branches.branches(root)).local.map((branch) => branch.name),
        ["main"],
      );
      const current = yield* branches.deleteBranch(root, "main").pipe(Effect.flip);
      assert.include(current.message, "checked out");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("sets and clears a branch's upstream", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      yield* box.remote(root);
      yield* git(root, "push", "-q", "origin", "main");
      assert.isUndefined((yield* branches.state(root)).upstream);
      yield* branches.setUpstream(root, "main", "origin/main");
      assert.strictEqual((yield* branches.state(root)).upstream?.name, "origin/main");
      yield* branches.setUpstream(root, "main");
      assert.isUndefined((yield* branches.state(root)).upstream);
      const missing = yield* branches.setUpstream(root, "main", "origin/nope").pipe(Effect.flip);
      assert.include(missing.message, "doesn't exist");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
