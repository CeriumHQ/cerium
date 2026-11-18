import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { GitBranches } from "../src/gitBranches.ts";
import { makeGitBranchesFixture } from "./gitBranchesRepoFixtures.ts";

const { git, sandbox, TestLayer } = makeGitBranchesFixture();

/** `main` and `feature` both change `a.txt` from "base": the next merge of one into the other conflicts. */
const diverged = Effect.gen(function* () {
  const box = yield* sandbox;
  const root = yield* box.init("repo");
  yield* git(root, "switch", "-q", "-c", "feature");
  yield* box.commit(root, "a.txt", "feature\n", "feature change");
  yield* git(root, "switch", "-q", "main");
  yield* box.commit(root, "a.txt", "main\n", "main change");
  return { ...box, root };
});

describe("GitBranches merging", () => {
  it.effect("merges a branch cleanly, and says when there is nothing to merge", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      yield* git(root, "switch", "-q", "-c", "feature");
      yield* box.commit(root, "f.txt", "f\n");
      yield* git(root, "switch", "-q", "main");
      assert.deepStrictEqual(yield* branches.merge(root, "feature"), {});
      assert.isTrue(yield* box.exists(root, "f.txt"));
      assert.deepStrictEqual(yield* branches.merge(root, "feature"), { unchanged: true });
      const unknown = yield* branches.merge(root, "nope").pipe(Effect.flip);
      assert.strictEqual(unknown.message, "Git doesn't know that branch.");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("stops a merge on conflicts, lets each file take a side, and continues", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const { root, read } = yield* diverged;
      assert.deepStrictEqual(yield* branches.merge(root, "feature"), { conflicted: true });
      const state = yield* branches.state(root);
      assert.deepStrictEqual(state.operation, { kind: "merge" });
      assert.deepStrictEqual(state.conflicts, [
        { path: "a.txt", inFolder: "a.txt", ours: "modified", theirs: "modified" },
      ]);

      // Nothing else starts, and the merge can't continue, while a file is unsettled.
      const switching = yield* branches.switchTo(root, "feature").pipe(Effect.flip);
      assert.strictEqual(switching.message, "Finish or abort the merge in progress first.");
      const early = yield* branches.operation(root, "continue").pipe(Effect.flip);
      assert.strictEqual(early.message, "Resolve every conflicted file first, then continue.");
      const skip = yield* branches.operation(root, "skip").pipe(Effect.flip);
      assert.strictEqual(skip.message, "A merge has no step to skip. Abort it instead.");

      yield* branches.resolve(root, "a.txt", "theirs");
      assert.strictEqual(yield* read(root, "a.txt"), "feature\n");
      assert.deepStrictEqual((yield* branches.state(root)).conflicts, []);
      assert.deepStrictEqual(yield* branches.operation(root, "continue"), {});
      const done = yield* branches.state(root);
      assert.isUndefined(done.operation);
      assert.strictEqual(done.changes, 0);
      // A merge commit has two parents.
      assert.strictEqual((yield* git(root, "rev-list", "--merges", "--count", "HEAD")).trim(), "1");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("takes our side of a conflict, or one resolved by hand", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const { root, read, write } = yield* diverged;
      yield* branches.merge(root, "feature");
      yield* branches.resolve(root, "a.txt", "ours");
      assert.strictEqual(yield* read(root, "a.txt"), "main\n");
      assert.deepStrictEqual(yield* branches.operation(root, "abort"), {});
      assert.isUndefined((yield* branches.state(root)).operation);

      yield* branches.merge(root, "feature");
      yield* write(root, "a.txt", "both\n");
      yield* branches.resolve(root, "a.txt", "resolved");
      assert.deepStrictEqual((yield* branches.state(root)).conflicts, []);
      yield* branches.operation(root, "continue");
      assert.strictEqual(yield* read(root, "a.txt"), "both\n");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("aborts a merge and leaves the branch as it was", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const { root, read } = yield* diverged;
      const before = yield* git(root, "rev-parse", "HEAD");
      yield* branches.merge(root, "feature");
      assert.deepStrictEqual(yield* branches.operation(root, "abort"), {});
      assert.strictEqual(yield* git(root, "rev-parse", "HEAD"), before);
      assert.strictEqual(yield* read(root, "a.txt"), "main\n");
      const nothing = yield* branches.operation(root, "abort").pipe(Effect.flip);
      assert.strictEqual(nothing.message, "Nothing is waiting to be continued.");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("settles a file one side deleted by deleting it, or keeping it", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      yield* box.commit(root, "b.txt", "b\n", "add b");
      yield* git(root, "switch", "-q", "-c", "feature");
      yield* git(root, "rm", "-q", "b.txt");
      yield* git(root, "commit", "-q", "-m", "delete b");
      yield* git(root, "switch", "-q", "main");
      yield* box.commit(root, "b.txt", "b changed\n", "change b");

      yield* branches.merge(root, "feature");
      assert.deepStrictEqual((yield* branches.state(root)).conflicts, [
        { path: "b.txt", inFolder: "b.txt", ours: "modified", theirs: "deleted" },
      ]);
      yield* branches.resolve(root, "b.txt", "theirs");
      assert.isFalse(yield* box.exists(root, "b.txt"));
      assert.deepStrictEqual((yield* branches.state(root)).conflicts, []);
      yield* branches.operation(root, "abort");

      yield* branches.merge(root, "feature");
      yield* branches.resolve(root, "b.txt", "ours");
      assert.strictEqual(yield* box.read(root, "b.txt"), "b changed\n");
      yield* branches.operation(root, "continue");
      assert.isUndefined((yield* branches.state(root)).operation);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("names a conflict by its path from the repository's top when the folder is inside it", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      yield* box.commit(root, "apps/ui/x.txt", "base\n", "add x");
      yield* box.commit(root, "other/y.txt", "base\n", "add y");
      yield* git(root, "switch", "-q", "-c", "feature");
      yield* box.commit(root, "apps/ui/x.txt", "feature\n");
      yield* box.commit(root, "other/y.txt", "feature\n");
      yield* git(root, "switch", "-q", "main");
      yield* box.commit(root, "apps/ui/x.txt", "main\n");
      yield* box.commit(root, "other/y.txt", "main\n");
      const folder = box.path.join(root, "apps", "ui");
      yield* branches.merge(folder, "feature");
      const conflicts = (yield* branches.state(folder)).conflicts;
      assert.deepStrictEqual(
        conflicts.map(({ path, inFolder }) => [path, inFolder]),
        [
          ["apps/ui/x.txt", "x.txt"],
          ["other/y.txt", undefined],
        ],
      );
      // A path from the top works from any folder inside.
      yield* branches.resolve(folder, "other/y.txt", "ours");
      yield* branches.resolve(folder, "apps/ui/x.txt", "theirs");
      assert.deepStrictEqual((yield* branches.state(folder)).conflicts, []);
      assert.strictEqual(yield* box.read(root, "apps/ui/x.txt"), "feature\n");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("goes through a rebase that stops on conflicts: abort, skip and continue", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const { root, read } = yield* diverged;
      yield* git(root, "switch", "-q", "feature");
      const before = (yield* git(root, "rev-parse", "HEAD")).trim();
      const rebase = () => git(root, "rebase", "main").pipe(Effect.ignore);

      yield* rebase();
      const state = yield* branches.state(root);
      assert.deepStrictEqual(state.operation, { kind: "rebase", step: 1, total: 1 });
      assert.deepStrictEqual(
        state.conflicts.map((file) => file.path),
        ["a.txt"],
      );
      assert.deepStrictEqual(yield* branches.operation(root, "abort"), {});
      assert.isUndefined((yield* branches.state(root)).operation);
      assert.strictEqual((yield* git(root, "rev-parse", "HEAD")).trim(), before);

      yield* rebase();
      assert.deepStrictEqual(yield* branches.operation(root, "skip"), {});
      assert.isUndefined((yield* branches.state(root)).operation);
      assert.strictEqual(yield* read(root, "a.txt"), "main\n");

      yield* git(root, "reset", "-q", "--hard", before);
      yield* rebase();
      // In a rebase `theirs` is the commit being replayed: the user's own change.
      yield* branches.resolve(root, "a.txt", "theirs");
      assert.deepStrictEqual(yield* branches.operation(root, "continue"), {});
      assert.isUndefined((yield* branches.state(root)).operation);
      assert.strictEqual(yield* read(root, "a.txt"), "feature\n");
      assert.strictEqual((yield* git(root, "log", "-1", "--format=%s")).trim(), "feature change");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("goes through a cherry-pick that stops on conflicts", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const { root, read } = yield* diverged;
      yield* git(root, "cherry-pick", "feature").pipe(Effect.ignore);
      const state = yield* branches.state(root);
      assert.deepStrictEqual(state.operation, { kind: "cherry-pick" });
      assert.lengthOf(state.conflicts, 1);
      yield* branches.resolve(root, "a.txt", "theirs");
      assert.deepStrictEqual(yield* branches.operation(root, "continue"), {});
      assert.isUndefined((yield* branches.state(root)).operation);
      assert.strictEqual(yield* read(root, "a.txt"), "feature\n");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuses paths that aren't in the repository, and files that aren't conflicted", () =>
    Effect.gen(function* () {
      const branches = yield* GitBranches;
      const box = yield* sandbox;
      const root = yield* box.init("repo");
      for (const bad of ["/etc/passwd", "C:\\Windows", "a\0b"]) {
        const error = yield* branches.resolve(root, bad, "resolved").pipe(Effect.flip);
        assert.deepStrictEqual([bad, error.message], [bad, "That path isn't inside the repository."]);
      }
      const clean = yield* branches.resolve(root, "a.txt", "ours").pipe(Effect.flip);
      assert.strictEqual(clean.message, "a.txt has no conflict to settle.");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
