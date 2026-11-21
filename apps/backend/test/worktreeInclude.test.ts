import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { includeList } from "../src/worktreeInclude.ts";
import { git, setup, TestLayer } from "./worktree.fixture.ts";

describe("includeList", () => {
  it("matches names at any depth, and paths with a slash from the root", () => {
    const list = includeList([".env", ".env.*", "/AGENTS.md", "# a comment", ""]);
    expect(list.includes(".env", false)).toBe(true);
    expect(list.includes("apps/web/.env.local", false)).toBe(true);
    expect(list.includes("AGENTS.md", false)).toBe(true);
    expect(list.includes("node_modules/vite-plus/AGENTS.md", false)).toBe(false);
    expect(list.includes("# a comment", false)).toBe(false);
  });

  it("takes a folder whole, folders only when the line ends in a slash, and lets later lines take back", () => {
    const list = includeList(["/vendor/effect/", "dist/", "build", "secrets/*.json", "!secrets/public.json"]);
    expect(list.includes("vendor/effect", true)).toBe(true);
    expect(list.includes("vendor/effect/src/index.ts", false)).toBe(true);
    expect(list.includes("vendor", true)).toBe(false);
    expect(list.includes("apps/ui/dist", true)).toBe(true);
    expect(list.includes("dist", false)).toBe(false);
    expect(list.includes("build", false)).toBe(true);
    expect(list.includes("secrets/key.json", false)).toBe(true);
    expect(list.includes("secrets/public.json", false)).toBe(false);
    expect(list.includes("secrets/deep/key.json", false)).toBe(false);
  });

  it("looks into an ignored folder only when a line with a slash names something in it", () => {
    const list = includeList(["/.claude/skills/", "/.claude/settings.json", ".env"]);
    expect(list.reachesInto(".claude")).toBe(true);
    expect(list.reachesInto(".claude/worktrees")).toBe(false);
    expect(list.reachesInto("node_modules")).toBe(false);
    expect(list.includes(".claude/skills/a/SKILL.md", false)).toBe(true);
    // `**` can reach anywhere.
    const deep = includeList(["**/fixtures/*.env"]);
    expect(deep.reachesInto("node_modules")).toBe(true);
    expect(deep.includes("packages/a/fixtures/test.env", false)).toBe(true);
  });

  it("copies root and nested files selected by a double-star include rule", () => {
    const all = includeList(["**"]);
    expect(all.includes("config.env", false)).toBe(true);
    expect(all.includes("nested/config.env", false)).toBe(true);
  });
});

describe("Worktrees included files", () => {
  it.effect("reuses a checkout without overwriting its ignored local environment files", () =>
    Effect.gen(function* () {
      const { fs, path, repo, worktrees } = yield* setup;
      const first = yield* worktrees.create(repo, "Shared checkout");
      yield* fs.writeFileString(path.join(first.worktree.root, ".env"), "KEY=kept\n");
      const reused = yield* worktrees.plan(repo, "Another conversation", { path: first.worktree.root });
      yield* worktrees.checkOut(reused.worktree);
      assert.strictEqual(reused.worktree.id, first.worktree.id);
      assert.strictEqual(yield* fs.readFileString(path.join(first.worktree.root, ".env")), "KEY=kept\n");
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            worktrees.plan(repo, "Subfolder", { path: path.join(first.worktree.root, "app") }),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
  it.effect(
    "checks the repository out on a branch of its own, in the same subfolder, with its env files",
    () =>
      Effect.gen(function* () {
        const { fs, path, repo, home, worktrees } = yield* setup;
        const { worktree, cwd, copied } = yield* worktrees.create(path.join(repo, "app"), "Fix the login");
        assert.deepStrictEqual(copied, [".env", "app/.env.local"]);
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

  it.effect("looks into an ignored folder only for what a line names in it, and never into the rest", () =>
    Effect.gen(function* () {
      const { fs, path, repo, write, worktrees } = yield* setup;
      yield* write(repo, ".gitignore", ".env\n.claude/\nnode_modules/\n");
      yield* write(repo, ".worktreeinclude", "/.claude/skills/\n/.claude/settings.json\n.env\n");
      yield* write(repo, ".claude/skills/review/SKILL.md", "skill\n");
      yield* write(repo, ".claude/settings.json", "{}\n");
      yield* write(repo, ".claude/worktrees/other/file.txt", "another checkout\n");
      yield* write(repo, "node_modules/pkg/.env", "a package's own\n");
      const { worktree, copied } = yield* worktrees.create(repo, "Skills");
      assert.deepStrictEqual(copied, [".claude/settings.json", ".claude/skills/", ".env"]);
      assert.isTrue(yield* fs.exists(path.join(worktree.root, ".claude", "skills", "review", "SKILL.md")));
      assert.isFalse(yield* fs.exists(path.join(worktree.root, ".claude", "worktrees")));
      assert.isFalse(yield* fs.exists(path.join(worktree.root, "node_modules")));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("never copies over a file the worktree has, an ignored one committed anyway included", () =>
    Effect.gen(function* () {
      const { fs, path, repo, write, worktrees } = yield* setup;
      yield* git(repo, "add", "-f", ".env");
      yield* git(repo, "commit", "-q", "-m", "keep the env file");
      yield* write(repo, ".env", "KEY=changed locally\n");
      const { worktree, copied } = yield* worktrees.create(repo, "Tracked");
      // The commit's own file stands, and only what the worktree lacked was copied.
      assert.strictEqual((yield* fs.readFileString(path.join(worktree.root, ".env"))).trim(), "KEY=root");
      assert.deepStrictEqual(copied, ["app/.env.local"]);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
