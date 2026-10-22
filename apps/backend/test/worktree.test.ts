import { Worktrees } from "@cerium/orchestrator";
import type { ThreadId } from "@cerium/protocol";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { Terminals } from "../src/terminal.ts";
import { Git } from "../src/git.ts";
import { countStatus, worktreeSlug, worktreesLayer } from "../src/worktree.ts";

describe("worktreeSlug", () => {
  it("names a worktree after the first words of its thread's title", () => {
    expect(worktreeSlug("Fix the login flow on Windows")).toBe("fix-the-login-flow-on-windows");
    expect(worktreeSlug("I would like you to create a worktree per thread feature")).toBe(
      "i-would-like-you-to-create-a",
    );
    expect(worktreeSlug("Café: ünïcode & `symbols`!")).toBe("cafe-unicode-symbols");
  });

  it("falls back to a name for a title with nothing to name it by", () => {
    expect(worktreeSlug("")).toBe("thread");
    expect(worktreeSlug("🙂 ✨")).toBe("thread");
    expect(worktreeSlug("x".repeat(50))).toBe("x".repeat(32));
  });

  it("avoids the names Windows keeps for devices", () => {
    expect(worktreeSlug("CON")).toBe("con-thread");
    expect(worktreeSlug("nul")).toBe("nul-thread");
    expect(worktreeSlug("console")).toBe("console");
  });
});

describe("countStatus", () => {
  it("counts each changed file once, a rename's old path included in its entry", () => {
    expect(countStatus("")).toBe(0);
    expect(countStatus(" M src/a.ts\0?? new.txt\0")).toBe(2);
    expect(countStatus("R  b.ts\0a.ts\0 D gone.txt\0")).toBe(2);
  });
});

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

const closed: Array<string> = [];
const fakeTerminals = Layer.succeed(Terminals, {
  closeThread: (threadId: ThreadId) => Effect.sync(() => void closed.push(threadId)),
} as unknown as Terminals["Service"]);

/** A repository with an app in a subfolder, environment files and a built folder, and a home for its worktrees. */
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = yield* fs.makeTempDirectoryScoped();
  const home = yield* fs.makeTempDirectoryScoped();
  const write = (root: string, name: string, text: string) =>
    fs
      .makeDirectory(path.dirname(path.join(root, name)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(root, name), text)));
  yield* git(repo, "init", "-q", "-b", "main");
  yield* write(repo, ".gitignore", ".env\n.env.*\n!.env.example\ndist/\nsecrets.json\n");
  yield* write(repo, ".env.example", "KEY=\n");
  yield* write(repo, "app/src/index.ts", "export {};\n");
  yield* git(repo, "add", "-A");
  yield* git(repo, "commit", "-q", "-m", "first");
  yield* write(repo, ".env", "KEY=root\n");
  yield* write(repo, "app/.env.local", "KEY=app\n");
  yield* write(repo, "dist/out.js", "built\n");
  yield* write(repo, "secrets.json", "{}\n");
  const worktrees = yield* Effect.provide(
    Effect.gen(function* () {
      return yield* Worktrees;
    }),
    worktreesLayer({ directory: home }),
  );
  return { fs, path, repo, home, write, worktrees };
});

const TestLayer = Layer.mergeAll(Git.layer, fakeTerminals).pipe(Layer.provideMerge(NodeServices.layer));

describe("Worktrees", () => {
  it.effect(
    "checks the repository out on a branch of its own, in the same subfolder, with its env files",
    () =>
      Effect.gen(function* () {
        const { fs, path, repo, home, worktrees } = yield* setup;
        const { worktree, cwd } = yield* worktrees.create(path.join(repo, "app"), "Fix the login");
        assert.strictEqual(worktree.branch, "cerium/fix-the-login");
        assert.strictEqual(worktree.base, "main");
        assert.strictEqual(worktree.project, path.join(repo, "app"));
        assert.strictEqual(worktree.root, path.join(home, path.basename(repo), "fix-the-login"));
        assert.strictEqual(cwd, path.join(worktree.root, "app"));
        assert.isTrue(yield* fs.exists(path.join(cwd, "src", "index.ts")));
        // Without a `.worktreeinclude`, ignored environment files come along, and nothing else ignored.
        assert.strictEqual(yield* fs.readFileString(path.join(worktree.root, ".env")), "KEY=root\n");
        assert.strictEqual(yield* fs.readFileString(path.join(cwd, ".env.local")), "KEY=app\n");
        assert.isFalse(yield* fs.exists(path.join(worktree.root, "dist")));
        assert.isFalse(yield* fs.exists(path.join(worktree.root, "secrets.json")));
        assert.strictEqual((yield* git(cwd, "branch", "--show-current")).trim(), "cerium/fix-the-login");

        // Threads of the same name, even started together, get worktrees of their own.
        const [second, third] = yield* Effect.all(
          [worktrees.create(repo, "Fix the login"), worktrees.create(repo, "Fix the login")],
          { concurrency: 2 },
        );
        assert.deepStrictEqual([second.worktree.branch, third.worktree.branch].toSorted(), [
          "cerium/fix-the-login-2",
          "cerium/fix-the-login-3",
        ]);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("copies what .worktreeinclude lists, as long as git ignores it", () =>
    Effect.gen(function* () {
      const { fs, path, repo, write, worktrees } = yield* setup;
      yield* write(repo, ".worktreeinclude", "secrets.json\ndist/\n# a comment\nnotes.md\n");
      // Listed but not ignored: the user's own work in progress, which stays put.
      yield* write(repo, "notes.md", "draft\n");
      const { worktree } = yield* worktrees.create(repo, "Include");
      assert.isTrue(yield* fs.exists(path.join(worktree.root, "secrets.json")));
      assert.isTrue(yield* fs.exists(path.join(worktree.root, "dist", "out.js")));
      assert.isFalse(yield* fs.exists(path.join(worktree.root, ".env")));
      assert.isFalse(yield* fs.exists(path.join(worktree.root, "notes.md")));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("counts uncommitted and unmerged work, and keeps the branch of commits when removed", () =>
    Effect.gen(function* () {
      const { fs, path, repo, write, worktrees } = yield* setup;
      const { worktree } = yield* worktrees.create(repo, "Work");
      assert.deepStrictEqual(yield* worktrees.changes(worktree), { uncommitted: 0, unmerged: 0 });

      yield* write(worktree.root, "app/src/index.ts", "export const a = 1;\n");
      yield* write(worktree.root, "app/src/new.ts", "new\n");
      assert.deepStrictEqual(yield* worktrees.changes(worktree), { uncommitted: 2, unmerged: 0 });
      yield* git(worktree.root, "add", "-A");
      yield* git(worktree.root, "commit", "-q", "-m", "work");
      yield* write(worktree.root, "README.md", "more\n");
      assert.deepStrictEqual(yield* worktrees.changes(worktree), { uncommitted: 1, unmerged: 1 });

      yield* worktrees.remove("thr_work" as ThreadId, worktree);
      assert.include(closed, "thr_work");
      assert.isFalse(yield* fs.exists(worktree.root));
      // The commit survives on its branch; the uncommitted file went with the folder.
      assert.include(yield* git(repo, "branch", "--list", worktree.branch), worktree.branch);
      assert.deepStrictEqual(yield* worktrees.changes(worktree), { uncommitted: 0, unmerged: 1 });

      // Restoring checks the branch out again, with its commit and its env files.
      yield* worktrees.restore(worktree);
      assert.isTrue(yield* fs.exists(path.join(worktree.root, "app", "src", "new.ts")));
      assert.isTrue(yield* fs.exists(path.join(worktree.root, ".env")));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "deletes the branch of a worktree with nothing its base lacks, and makes it afresh on restore",
    () =>
      Effect.gen(function* () {
        const { fs, repo, worktrees } = yield* setup;
        const { worktree } = yield* worktrees.create(repo, "Nothing");
        yield* worktrees.remove("thr_nothing" as ThreadId, worktree);
        assert.strictEqual((yield* git(repo, "branch", "--list", worktree.branch)).trim(), "");
        yield* worktrees.restore(worktree);
        assert.isTrue(yield* fs.exists(worktree.root));
        assert.strictEqual((yield* git(worktree.root, "branch", "--show-current")).trim(), worktree.branch);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuses a folder outside git, and a repository without commits", () =>
    Effect.gen(function* () {
      const { fs, worktrees } = yield* setup;
      const plain = yield* fs.makeTempDirectoryScoped();
      const outside = yield* Effect.exit(worktrees.create(plain, "x"));
      assert.isTrue(Exit.isFailure(outside));
      assert.include(String(outside), "isn't in a git repository");
      yield* git(plain, "init", "-q", "-b", "main");
      const empty = yield* Effect.exit(worktrees.create(plain, "x"));
      assert.include(String(empty), "has no commits yet");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
