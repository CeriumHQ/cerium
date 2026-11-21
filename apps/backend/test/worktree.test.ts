import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { ThreadId } from "@cerium/protocol";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { GitHub } from "../src/github.ts";
import { countStatus, worktreeSlug } from "../src/worktree.ts";
import { git, closed, setup, TestLayer } from "./worktree.fixture.ts";

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

describe("Worktrees", () => {
  it.effect("checks out a PR head and its remote base without moving the project's checkout", () =>
    Effect.gen(function* () {
      const { repo, fs, path, worktrees } = yield* setup;
      const main = (yield* git(repo, "rev-parse", "HEAD")).trim();
      const remote = path.join(yield* fs.makeTempDirectoryScoped(), "remote.git");
      yield* git(repo, "clone", "--bare", repo, remote);
      const tree = (yield* git(repo, "rev-parse", "HEAD^{tree}")).trim();
      const base = (yield* git(repo, "commit-tree", tree, "-p", main, "-m", "Release branch")).trim();
      const head = (yield* git(repo, "commit-tree", tree, "-p", main, "-m", "Proposed fix")).trim();
      yield* git(repo, "push", remote, `${base}:refs/heads/release`, `${head}:refs/pull/42/head`);
      yield* git(
        repo,
        "config",
        `url.${pathToFileURL(remote).href}.insteadOf`,
        "https://github.com/example/project",
      );
      const pullRequestUrl = "https://github.com/example/project/pull/42";
      const made = yield* worktrees.plan(repo, "Pull request 42", { pullRequestUrl, baseRef: "release" });
      assert.strictEqual(made.worktree.baseCommit, base);
      assert.strictEqual(made.worktree.startCommit, head);
      assert.strictEqual(made.worktree.pullRequestUrl, pullRequestUrl);
      yield* worktrees.checkOut(made.worktree);
      assert.strictEqual((yield* git(made.cwd, "rev-parse", "HEAD")).trim(), head);
      assert.strictEqual((yield* git(repo, "rev-parse", "HEAD")).trim(), main);
      assert.strictEqual((yield* git(repo, "for-each-ref", "refs/cerium/worktree-fetch")).trim(), "");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          TestLayer,
          Layer.succeed(GitHub, {
            repository: () =>
              Effect.succeed({
                host: "github.com",
                owner: "example",
                name: "project",
                url: "https://github.com/example/project",
              }),
          } as never),
        ),
      ),
    ),
  );

  it.effect("keeps a cleaned workspace's branch available for restoration", () =>
    Effect.gen(function* () {
      const { repo, worktrees } = yield* setup;
      const made = yield* worktrees.create(repo, "Retained branch");
      yield* worktrees.remove("thr_clean" as ThreadId, made.worktree, { keepBranch: true });
      assert.strictEqual(
        (yield* git(repo, "rev-parse", `refs/heads/${made.worktree.branch}`)).trim(),
        made.worktree.startCommit,
      );
      yield* worktrees.restore(made.worktree);
      assert.strictEqual(
        (yield* git(made.worktree.root, "rev-parse", "HEAD")).trim(),
        made.worktree.startCommit,
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
  it.effect("pins a new checkout to the selected base even when that branch advances before checkout", () =>
    Effect.gen(function* () {
      const { repo, worktrees } = yield* setup;
      const planned = yield* worktrees.plan(repo, "Pinned base", {
        baseRef: "main",
        branch: "feature/pinned",
      });
      yield* git(repo, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "advance base");
      yield* worktrees.checkOut(planned.worktree);
      assert.strictEqual(
        (yield* git(planned.worktree.root, "rev-parse", "HEAD")).trim(),
        planned.worktree.startCommit,
      );
      assert.notStrictEqual((yield* git(repo, "rev-parse", "HEAD")).trim(), planned.worktree.startCommit);
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
        // Git forgot it as soon as its folder moved aside.
        assert.notInclude(yield* git(repo, "worktree", "list"), worktree.root.replaceAll("\\", "/"));
        yield* worktrees.restore(worktree);
        assert.isTrue(yield* fs.exists(worktree.root));
        assert.strictEqual((yield* git(worktree.root, "branch", "--show-current")).trim(), worktree.branch);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live(
    "lets go of a worktree a process still runs in at once, and deletes its folder once it ends",
    () =>
      Effect.gen(function* () {
        const { fs, repo, worktrees } = yield* setup;
        const { worktree } = yield* worktrees.create(repo, "Held");
        // A dev server left running in the folder, which Windows won't let it move while it does.
        const held = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2500)"], {
          cwd: worktree.root,
          stdio: "ignore",
        });
        const ended = new Promise((resolve) => held.once("exit", resolve));
        const started = Date.now();
        yield* worktrees.remove("thr_held" as ThreadId, worktree);
        assert.isBelow(Date.now() - started, 2400);
        assert.strictEqual((yield* git(repo, "branch", "--list", worktree.branch)).trim(), "");
        assert.notInclude(yield* git(repo, "worktree", "list"), worktree.root.replaceAll("\\", "/"));
        // Restoring waits for the folder to go, then checks the branch out afresh.
        yield* Effect.promise(() => ended);
        yield* worktrees.restore(worktree);
        assert.strictEqual((yield* git(worktree.root, "branch", "--show-current")).trim(), worktree.branch);
        assert.isTrue(yield* fs.exists(worktree.root));
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    20_000,
  );

  it.effect("refuses a folder outside git, and a repository without commits", () =>
    Effect.gen(function* () {
      const { fs, worktrees } = yield* setup;
      const plain = yield* fs.makeTempDirectoryScoped();
      const outside = yield* Effect.exit(worktrees.plan(plain, "x"));
      assert.isTrue(Exit.isFailure(outside));
      assert.include(String(outside), "isn't in a git repository");
      yield* git(plain, "init", "-q", "-b", "main");
      const empty = yield* Effect.exit(worktrees.plan(plain, "x"));
      assert.include(String(empty), "has no commits yet");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
