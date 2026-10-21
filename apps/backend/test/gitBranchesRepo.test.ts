import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { GitBranches } from "../src/gitBranches.ts";

// Real repositories, as the service sees them.
const TestLayer = GitBranches.layer.pipe(Layer.provideMerge(NodeServices.layer));

/** Runs git in `cwd` as the test's own user, away from the machine's git configuration. */
const git = Effect.fn("git")(function* (cwd: string, ...args: Array<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(
    ChildProcess.make(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args],
      { cwd },
    ),
  );
});

/** A folder of temporary repositories: `init` makes one with its own identity, `remote` a bare one. */
const sandbox = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const base = yield* fs.makeTempDirectoryScoped();
  const write = (root: string, name: string, text: string) =>
    fs
      .makeDirectory(path.dirname(path.join(root, name)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(root, name), text)));
  const read = (root: string, name: string) => fs.readFileString(path.join(root, name));
  const exists = (root: string, name: string) => fs.exists(path.join(root, name));
  const configure = Effect.fn("configure")(function* (root: string, name: string) {
    for (const [key, value] of [
      ["user.name", name],
      ["user.email", `${name.toLowerCase()}@example.com`],
      ["core.autocrlf", "false"],
      ["commit.gpgsign", "false"],
    ] as const) {
      yield* git(root, "config", key, value);
    }
  });
  /** Makes a repository with one commit that holds `a.txt`. */
  const init = Effect.fn("init")(function* (name: string) {
    const root = path.join(base, name);
    yield* fs.makeDirectory(root, { recursive: true });
    yield* git(root, "init", "-q", "-b", "main");
    yield* configure(root, "Test");
    yield* write(root, "a.txt", "base\n");
    yield* git(root, "add", "-A");
    yield* git(root, "commit", "-q", "-m", "base");
    return root;
  });
  /** Commits `text` to `file` on whatever is checked out in `root`. */
  const commit = Effect.fn("commit")(function* (
    root: string,
    file: string,
    text: string,
    message = "change",
  ) {
    yield* write(root, file, text);
    yield* git(root, "add", "-A");
    yield* git(root, "commit", "-q", "-m", message);
  });
  /** A bare repository for `root` to push to, as its `origin`. */
  const remote = Effect.fn("remote")(function* (root: string, name = "origin.git") {
    const bare = path.join(base, name);
    yield* git(base, "init", "-q", "--bare", "-b", "main", bare);
    yield* git(root, "remote", "add", "origin", bare);
    return bare;
  });
  /** Another clone of `bare`, as a second person's. */
  const clone = Effect.fn("clone")(function* (bare: string, name: string) {
    const root = path.join(base, name);
    yield* git(base, "clone", "-q", bare, root);
    yield* configure(root, "Other");
    return root;
  });
  return { base, path, fs, write, read, exists, init, commit, remote, clone };
});

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

describe("GitBranches state and branches", { timeout: 60_000 }, () => {
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

describe("GitBranches switching", { timeout: 60_000 }, () => {
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

describe("GitBranches branch management", { timeout: 60_000 }, () => {
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

describe("GitBranches syncing", { timeout: 60_000 }, () => {
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

describe("GitBranches stash", { timeout: 60_000 }, () => {
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

describe("GitBranches merging", { timeout: 60_000 }, () => {
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
