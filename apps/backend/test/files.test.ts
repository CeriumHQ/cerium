import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, FileSystem, Layer, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { posix, win32 } from "node:path";

import {
  compareEntries,
  Files,
  parseStatus,
  pathSegments,
  resolveInside,
  stateOf,
  watchedChange,
} from "../src/files.ts";

describe("paths", () => {
  it("keeps a path under the folder it is asked about", () => {
    expect(resolveInside("/work/app", "src/ui/App.tsx", posix)).toBe("/work/app/src/ui/App.tsx");
    expect(resolveInside("/work/app", "", posix)).toBe("/work/app");
    expect(resolveInside("/work/app", "./a//b/./c", posix)).toBe("/work/app/a/b/c");
    expect(resolveInside("C:\\Work\\app", "src/ui/App.tsx", win32)).toBe("C:\\Work\\app\\src\\ui\\App.tsx");
  });

  it("refuses a path that climbs out, however it is spelled", () => {
    // Each path is listed with what it resolves to, so a failure names the path.
    for (const bad of ["..", "../x", "a/../../x", "a/..", "..\\x", "a\\..\\..\\x"]) {
      expect([bad, resolveInside("C:\\Work\\app", bad, win32)]).toEqual([bad, undefined]);
    }
    for (const bad of ["..", "../x", "a/../../x", "a/.."]) {
      expect([bad, resolveInside("/work/app", bad, posix)]).toEqual([bad, undefined]);
    }
    // On the other platforms a backslash is just part of a name.
    expect(resolveInside("/work/app", "a\\..\\x", posix)).toBe("/work/app/a\\..\\x");
  });

  it("refuses a path rooted somewhere else", () => {
    for (const bad of ["/etc/passwd", "\\\\server\\share\\x", "C:\\Windows", "C:evil", "D:/x", "\\Windows"]) {
      expect([bad, resolveInside("C:\\Work\\app", bad, win32)]).toEqual([bad, undefined]);
    }
    expect(resolveInside("/work/app", "/etc/passwd", posix)).toBeUndefined();
    expect(resolveInside("/work/app", "\0", posix)).toBeUndefined();
  });

  it("refuses names Windows would read as something else", () => {
    // A trailing dot or space is dropped by Windows, so `.. ` would climb like `..`.
    for (const bad of [
      ".. ",
      "a/... ",
      "a/b.",
      "x/.. /y",
      "a/nul",
      "NUL.txt",
      "a/COM1",
      "a/Con.log",
      "a:stream",
      "a/b?c",
      "a/b*",
    ]) {
      expect([bad, resolveInside("C:\\Work\\app", bad, win32)]).toEqual([bad, undefined]);
    }
    // Names that only look odd are fine.
    expect(resolveInside("C:\\Work\\app", "a/console.log", win32)).toBe("C:\\Work\\app\\a\\console.log");
    expect(resolveInside("C:\\Work\\app", "a/.gitignore", win32)).toBe("C:\\Work\\app\\a\\.gitignore");
    expect(resolveInside("C:\\Work\\app", "a/b c/d", win32)).toBe("C:\\Work\\app\\a\\b c\\d");
  });

  it("ignores case and separators the way Windows does", () => {
    expect(resolveInside("c:/work/APP/", "Src\\ui/app.tsx", win32)).toBe("c:\\work\\APP\\Src\\ui\\app.tsx");
    expect(pathSegments("a/b/", win32)).toEqual(["a", "b"]);
  });
});

describe("entries", () => {
  it("lists folders first, each group by name with numbers in order", () => {
    const names = [
      { name: "b.ts", folder: false },
      { name: "src", folder: true },
      { name: "File10.ts", folder: false },
      { name: "file2.ts", folder: false },
      { name: ".github", folder: true },
    ]
      .toSorted(compareEntries)
      .map((entry) => entry.name);
    expect(names).toEqual([".github", "src", "b.ts", "file2.ts", "File10.ts"]);
  });
});

describe("git status", () => {
  it("reads what each pair of letters means", () => {
    expect(stateOf(" ", "M")).toBe("modified");
    expect(stateOf("M", " ")).toBe("modified");
    expect(stateOf("A", " ")).toBe("added");
    expect(stateOf("A", "M")).toBe("added");
    expect(stateOf(" ", "D")).toBe("deleted");
    expect(stateOf("D", " ")).toBe("deleted");
    expect(stateOf("R", " ")).toBe("renamed");
    expect(stateOf("?", "?")).toBe("untracked");
    expect(stateOf("U", "U")).toBe("conflicted");
    expect(stateOf("A", "A")).toBe("conflicted");
    expect(stateOf("D", "D")).toBe("conflicted");
  });

  it("lists changes with where renames came from", () => {
    const output = [
      " M src/a.ts",
      "A  src/new.ts",
      "R  src/moved.ts",
      "src/was.ts",
      "?? notes/",
      "?? x y.txt",
      "",
    ].join("\0");
    expect(parseStatus(output, "")).toEqual([
      { path: "src/a.ts", state: "modified" },
      { path: "src/new.ts", state: "added" },
      { path: "src/moved.ts", state: "renamed", from: "src/was.ts" },
      { path: "notes/", state: "untracked" },
      { path: "x y.txt", state: "untracked" },
    ]);
  });

  it("keeps to the folder asked about when it sits inside the repository", () => {
    const output = [
      " M apps/ui/src/a.ts",
      " M packages/rpc/index.ts",
      "R  apps/ui/b.ts",
      "packages/old.ts",
      "",
      "",
    ].join("\0");
    expect(parseStatus(output, "apps/ui/")).toEqual([
      { path: "src/a.ts", state: "modified" },
      { path: "b.ts", state: "renamed" },
    ]);
  });

  it("skips ignored files, which only an explicit request lists", () => {
    expect(parseStatus(["!! dist/", " M a.ts", ""].join("\0"), "")).toEqual([
      { path: "a.ts", state: "modified" },
    ]);
  });
});

describe("watching", () => {
  it("passes what the explorer shows and drops what it doesn't", () => {
    expect(watchedChange("src\\a.ts")).toEqual({ path: "src/a.ts" });
    expect(watchedChange("node_modules")).toEqual({ path: "node_modules" });
    expect(watchedChange("node_modules/react/index.js")).toBeUndefined();
    expect(watchedChange("apps/ui/node_modules/x")).toBeUndefined();
    expect(watchedChange("target/debug/app.exe")).toBeUndefined();
    expect(watchedChange("")).toBeUndefined();
  });

  it("takes git's own state for a change of status", () => {
    expect(watchedChange(".git/index")).toEqual({ git: true });
    expect(watchedChange(".git\\HEAD")).toEqual({ git: true });
    expect(watchedChange(".git/refs/heads/main")).toEqual({ git: true });
    expect(watchedChange(".git/objects/ab/cdef")).toBeUndefined();
    expect(watchedChange(".git/index.lock")).toBeUndefined();
    expect(watchedChange(".hg/store")).toBeUndefined();
  });
});

// A real repository, as the service sees one.
const TestLayer = Files.layer.pipe(Layer.provideMerge(NodeServices.layer));

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

const repository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  const write = (name: string, text: string) =>
    fs
      .makeDirectory(path.dirname(path.join(root, name)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(root, name), text)));
  yield* git(root, "init", "-q", "-b", "main");
  yield* write(".gitignore", "dist/\n*.log\n");
  yield* write("README.md", "# Title\n\nHello\n");
  yield* write("src/app.ts", "one\ntwo\nthree\nfour\n");
  yield* write("src/old.ts", "export const old = 1;\n".repeat(5));
  yield* write("gone.txt", "bye\n");
  yield* git(root, "add", "-A");
  yield* git(root, "commit", "-q", "-m", "first");
  return { root, write, fs, path };
});

describe("Files", () => {
  it.effect("lists a folder a level at a time, ignored entries marked and git's own folder left out", () =>
    Effect.gen(function* () {
      const files = yield* Files;
      const { root, write, fs, path } = yield* repository;
      yield* write("dist/out.js", "x");
      yield* write("debug.log", "x");
      yield* fs.makeDirectory(path.join(root, "node_modules", "dep"), { recursive: true });
      const listing = yield* files.list(root, "");
      assert.deepStrictEqual(listing.entries, [
        { name: "dist", folder: true, ignored: true },
        { name: "node_modules", folder: true, heavy: true },
        { name: "src", folder: true },
        { name: ".gitignore", folder: false },
        { name: "debug.log", folder: false, ignored: true },
        { name: "gone.txt", folder: false },
        { name: "README.md", folder: false },
      ]);
      const inner = yield* files.list(root, "src/");
      assert.deepStrictEqual(
        inner.entries.map((entry) => entry.name),
        ["app.ts", "old.ts"],
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("lists a folder outside git without marking anything ignored", () =>
    Effect.gen(function* () {
      const files = yield* Files;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(path.join(root, "a.log"), "x");
      const listing = yield* files.list(root, "");
      assert.deepStrictEqual(listing.entries, [{ name: "a.log", folder: false }]);
      const statuses = yield* files.statuses(root);
      assert.deepStrictEqual(statuses, { repository: false, changes: [] });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuses paths outside the folder and folders that are gone", () =>
    Effect.gen(function* () {
      const files = yield* Files;
      const { root } = yield* repository;
      for (const bad of ["..", "../x", "src/../..", "C:\\Windows"]) {
        const exit = yield* Effect.exit(files.list(root, bad));
        assert.isTrue(Exit.isFailure(exit), bad);
      }
      assert.isTrue(Exit.isFailure(yield* Effect.exit(files.list(`${root}-missing`, ""))));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "says what git sees: modified, added, deleted, renamed and untracked, with new folders whole",
    () =>
      Effect.gen(function* () {
        const files = yield* Files;
        const { root, write, fs, path } = yield* repository;
        yield* write("src/app.ts", "one\nTWO\nthree\nfour\n");
        yield* write("added.ts", "a\n");
        yield* git(root, "add", "added.ts");
        yield* fs.remove(path.join(root, "gone.txt"));
        yield* git(root, "mv", "src/old.ts", "src/renamed.ts");
        yield* write("fresh/deep/one.txt", "1");
        yield* write("fresh/two.txt", "2");
        yield* write("debug.log", "ignored");
        const { repository: inRepository, changes } = yield* files.statuses(root);
        assert.isTrue(inRepository);
        assert.deepStrictEqual(
          changes.toSorted((a, b) => a.path.localeCompare(b.path)),
          [
            { path: "added.ts", state: "added" },
            { path: "fresh/", state: "untracked" },
            { path: "gone.txt", state: "deleted" },
            { path: "src/app.ts", state: "modified" },
            { path: "src/renamed.ts", state: "renamed", from: "src/old.ts" },
          ],
        );
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("reports paths relative to the folder asked about when it is inside a repository", () =>
    Effect.gen(function* () {
      const files = yield* Files;
      const { root, write, path } = yield* repository;
      yield* write("src/app.ts", "changed\n");
      yield* write("README.md", "changed\n");
      const { changes } = yield* files.statuses(path.join(root, "src"));
      assert.deepStrictEqual(changes, [{ path: "app.ts", state: "modified" }]);
      const listing = yield* files.list(path.join(root, "src"), "");
      assert.deepStrictEqual(
        listing.entries.map((entry) => entry.name),
        ["app.ts", "old.ts"],
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("tells the explorer what changes while it watches, in a batch", () =>
    Effect.gen(function* () {
      const files = yield* Files;
      const { root, write } = yield* repository;
      const watching = yield* files.watch(root).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
      yield* Effect.sleep("300 millis");
      yield* write("src/app.ts", "changed\n");
      yield* write("node_modules/dep/more.js", "ignored");
      yield* write("debug.log", "ignored too");
      const [batch] = yield* Fiber.join(watching).pipe(Effect.timeout("10 seconds"));
      assert.isDefined(batch);
      assert.isTrue(batch!.paths.includes("src/app.ts"));
      assert.isTrue(batch!.paths.includes("debug.log"));
      assert.isFalse(batch!.paths.some((path) => path.startsWith("node_modules/")));
      // The one change git sees makes the batch a change of status.
      assert.isTrue(batch!.status);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
