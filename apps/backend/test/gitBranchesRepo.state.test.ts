import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { GitBranches } from "../src/gitBranches.ts";
import { makeGitBranchesFixture } from "./gitBranchesRepoFixtures.ts";

const { git, sandbox, TestLayer } = makeGitBranchesFixture();

describe("GitBranches state and branches", () => {
  it.effect("says where a repository stands", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      const clean = yield* branches.state(root);
      assert.isTrue(clean.repository);
      assert.strictEqual(clean.branch, "main");
      assert.lengthOf(clean.commit ?? "", 7);
      assert.isUndefined(clean.upstream);
      assert.isUndefined(clean.detached);
      assert.deepStrictEqual(clean.remotes, []);
      assert.strictEqual(clean.changes, 0);
      assert.deepStrictEqual(clean.conflicts, []);
      yield* box.write(root, "new.txt", "x");
      yield* box.write(root, "a.txt", "changed\n");
      assert.strictEqual((yield* branches.state(root)).changes, 2);
      yield* box.remote(root);
      assert.deepStrictEqual((yield* branches.state(root)).remotes, ["origin"]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("names the commit when HEAD is detached", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      yield* git(root, "switch", "-q", "--detach");
      const state = yield* branches.state(root);
      assert.isUndefined(state.branch);
      assert.isTrue(state.detached);
      assert.lengthOf(state.commit ?? "", 7);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("says a folder outside git isn't a repository", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const state = yield* branches.state(box.base);
      assert.deepStrictEqual(state, { repository: false, remotes: [], changes: 0, conflicts: [] });
      const error = yield* branches.branches(box.base).pipe(Effect.flip);
      assert.strictEqual(error.message, "This folder isn't in a git repository.");
      // One made since shows at once, though git said a moment ago there was none.
      yield* git(box.base, "init", "-q", "-b", "main");
      assert.isTrue((yield* branches.state(box.base)).repository);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("lists local and remote branches, newest commit first", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      const bare = yield* box.remote(root);
      yield* git(root, "push", "-q", "-u", "origin", "main");
      yield* git(root, "branch", "older");
      yield* box.commit(root, "b.txt", "b\n", "second");
      const other = yield* box.clone(bare, "other");
      yield* git(other, "switch", "-q", "-c", "remote-only");
      yield* box.commit(other, "c.txt", "c\n", "remote work");
      yield* git(other, "push", "-q", "origin", "remote-only");
      yield* git(root, "fetch", "-q");
      const list = yield* branches.branches(root);
      assert.deepStrictEqual(
        list.local.map((branch) => [branch.name, branch.current]),
        [
          ["main", true],
          ["older", false],
        ],
      );
      const main = list.local[0]!;
      assert.deepStrictEqual(main.upstream, { name: "origin/main", ahead: 1, behind: 0, gone: false });
      assert.strictEqual(main.subject, "second");
      assert.isUndefined(list.local[1]!.upstream);
      assert.deepStrictEqual(list.remote.map((branch) => branch.name).toSorted(), [
        "origin/main",
        "origin/remote-only",
      ]);
      assert.strictEqual(list.remote.find((branch) => branch.name === "origin/main")!.local, "main");
      assert.isUndefined(list.remote.find((branch) => branch.name === "origin/remote-only")!.local);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
