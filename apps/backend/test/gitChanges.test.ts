import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { Git } from "../src/git.ts";
import { GitChanges, parseStatusV2 } from "../src/gitChanges.ts";

describe("git status", () => {
  it("splits each file into what's staged, what isn't and what's conflicted", () => {
    const hash = "0".repeat(40);
    const output = [
      `1 MM N... 100644 100644 100644 ${hash} ${hash} src/both changed.ts`,
      `1 A. N... 000000 100644 100644 ${hash} ${hash} added.ts`,
      `1 .D N... 100644 100644 000000 ${hash} ${hash} gone.ts`,
      `2 R. N... 100644 100644 100644 ${hash} ${hash} R100 new/name.ts`,
      "old/name.ts",
      `u UU N... 100644 100644 100644 100644 ${hash} ${hash} ${hash} fight.ts`,
      "? fresh.txt",
      "! ignored.log",
      "",
    ].join("\0");
    const { staged, unstaged, conflicted } = parseStatusV2(output);
    expect(staged).toEqual([
      { path: "added.ts", state: "added" },
      { path: "new/name.ts", state: "renamed", from: "old/name.ts" },
      { path: "src/both changed.ts", state: "modified" },
    ]);
    expect(unstaged).toEqual([
      { path: "fresh.txt", state: "untracked" },
      { path: "gone.ts", state: "deleted" },
      { path: "src/both changed.ts", state: "modified" },
    ]);
    expect(conflicted).toEqual([{ path: "fight.ts", state: "conflicted" }]);
  });
});

const TestLayer = GitChanges.layer.pipe(Layer.provide(Git.layer), Layer.provideMerge(NodeServices.layer));

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

export const repository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  const write = (name: string, text: string) =>
    fs
      .makeDirectory(path.dirname(path.join(root, name)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(root, name), text)));
  const read = (name: string) => fs.readFileString(path.join(root, name));
  yield* git(root, "init", "-q", "-b", "main");
  yield* git(root, "config", "core.autocrlf", "false");
  yield* git(root, "config", "user.name", "Test");
  yield* git(root, "config", "user.email", "test@example.com");
  yield* write(".gitignore", "*.log\n");
  yield* write("src/app.ts", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
  yield* write("README.md", "# Title\n");
  yield* git(root, "add", "-A");
  yield* git(root, "commit", "-q", "-m", "first");
  return { root, write, read, fs, path, git: (...args: Array<string>) => git(root, ...args) };
});

describe("GitChanges", () => {
  it.effect("lists the whole repository's changes from a folder inside it, relative to its top", () =>
    Effect.gen(function* () {
      const changes = yield* GitChanges;
      const { root, write, path, fs, git } = yield* repository;
      yield* write("src/app.ts", "one\n");
      yield* git("add", "src/app.ts");
      yield* write("src/app.ts", "one\nmore\n");
      yield* write("docs/new.md", "new\n");
      yield* write("debug.log", "ignored\n");
      const status = yield* changes.status(path.join(root, "src"));
      assert.isTrue(status.repository);
      assert.strictEqual(path.relative(yield* fs.realPath(root), yield* fs.realPath(status.top!)), "");
      assert.deepStrictEqual(status.staged, [{ path: "src/app.ts", state: "modified" }]);
      assert.deepStrictEqual(status.unstaged, [
        { path: "docs/new.md", state: "untracked" },
        { path: "src/app.ts", state: "modified" },
      ]);
      assert.deepStrictEqual(status.conflicted, []);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("says a folder outside git has no repository", () =>
    Effect.gen(function* () {
      const changes = yield* GitChanges;
      const fs = yield* FileSystem.FileSystem;
      const folder = yield* fs.makeTempDirectoryScoped();
      assert.deepStrictEqual(yield* changes.status(folder), {
        repository: false,
        staged: [],
        unstaged: [],
        conflicted: [],
      });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
