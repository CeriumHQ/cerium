import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Fiber, FileSystem, Layer, Path, Queue, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { watch } from "node:fs";
import { posix, win32 } from "node:path";

import {
  BYTES_CHUNK,
  compareEntries,
  decodeText,
  Files,
  gitFolderChange,
  gitFolderSkips,
  limitHunks,
  parseDiff,
  parseStatus,
  pathSegments,
  PREVIEW_BYTES,
  resolveInside,
  watchedChange,
  watchSkips,
  withoutPartialCharacter,
} from "../src/files.ts";
import { Git } from "../src/git.ts";

describe("paths", () => {
  it("keeps a path under the folder it is asked about", () => {
    expect(resolveInside("/work/app", "src/ui/App.tsx", posix)).toBe("/work/app/src/ui/App.tsx");
    expect(resolveInside("/work/app", "", posix)).toBe("/work/app");
    expect(resolveInside("/work/app", "./a//b/./c", posix)).toBe("/work/app/a/b/c");
    expect(resolveInside("C:\\Work\\app", "src/ui/App.tsx", win32)).toBe("C:\\Work\\app\\src\\ui\\App.tsx");
    expect(resolveInside("/work/app", "..notes", posix)).toBe("/work/app/..notes");
    expect(resolveInside("C:\\Work\\app", "..notes", win32)).toBe("C:\\Work\\app\\..notes");
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
    expect(watchedChange(".git/index")).toEqual({ git: true, refs: false });
    expect(watchedChange(".git\\HEAD")).toEqual({ git: true, refs: true });
    expect(watchedChange(".git/refs/heads/main")).toEqual({ git: true, refs: true });
    expect(watchedChange(".git/packed-refs")).toEqual({ git: true, refs: true });
    expect(watchedChange(".git/MERGE_HEAD")).toEqual({ git: true, refs: true });
    expect(watchedChange(".git/objects/ab/cdef")).toBeUndefined();
    expect(watchedChange(".git/index.lock")).toBeUndefined();
    expect(watchedChange(".hg/store")).toBeUndefined();
  });

  it("reads a worktree's own git folder apart from the one its worktrees share", () => {
    const own = { own: true, common: false };
    const common = { own: false, common: true };
    expect(gitFolderChange("index", own)).toEqual({ git: true, refs: false });
    expect(gitFolderChange("HEAD", own)).toEqual({ git: true, refs: true });
    expect(gitFolderChange("rebase-merge\\done", own)).toEqual({ git: true, refs: true });
    expect(gitFolderChange("refs/heads/main", own)).toBeUndefined();
    expect(gitFolderChange("refs/heads/main", common)).toEqual({ git: true, refs: true });
    // The main work tree's index and HEAD, and other worktrees', are none of this one's business.
    expect(gitFolderChange("index", common)).toBeUndefined();
    expect(gitFolderChange("worktrees/other/index", common)).toBeUndefined();
    expect(gitFolderChange("objects/ab/cdef", common)).toBeUndefined();
  });

  it("leaves unwatched what it would drop, and all below it", () => {
    expect(watchSkips("src")).toBe(false);
    expect(watchSkips("src/a.ts")).toBe(false);
    // A dependency folder's own entry still changes its parent's listing.
    expect(watchSkips("node_modules")).toBe(false);
    expect(watchSkips("apps/ui/node_modules")).toBe(false);
    expect(watchSkips("node_modules/react")).toBe(true);
    expect(watchSkips("apps\\ui\\node_modules\\react")).toBe(true);
    expect(watchSkips(".hg")).toBe(true);
    // Git's folder is walked for the index, HEAD and the refs, and nothing else.
    expect(watchSkips(".git")).toBe(false);
    expect(watchSkips(".git/index")).toBe(false);
    expect(watchSkips(".git/refs")).toBe(false);
    expect(watchSkips(".git/refs/heads/main")).toBe(false);
    expect(watchSkips(".git/rebase-merge")).toBe(false);
    expect(watchSkips(".git/objects")).toBe(true);
    expect(watchSkips(".git/logs")).toBe(true);
    expect(watchSkips(".git/worktrees")).toBe(true);
    expect(gitFolderSkips("refs", { own: false, common: true })).toBe(false);
    expect(gitFolderSkips("index", { own: true, common: false })).toBe(false);
    expect(gitFolderSkips("refs", { own: true, common: false })).toBe(true);
    expect(gitFolderSkips("worktrees", { own: false, common: true })).toBe(true);
  });
});

describe("git diff", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,4 @@ import x",
    " one",
    "-two",
    "+two!",
    "+three",
    " four",
    "\\ No newline at end of file",
    "@@ -20 +21,2 @@",
    "+added\r",
    "+more",
    "",
  ].join("\n");

  it("reads hunks with where they start", () => {
    const { hunks, binary } = parseDiff(diff);
    expect(binary).toBe(false);
    expect(hunks).toEqual([
      {
        oldStart: 1,
        newStart: 1,
        lines: [
          { kind: "context", text: "one" },
          { kind: "removed", text: "two" },
          { kind: "added", text: "two!" },
          { kind: "added", text: "three" },
          { kind: "context", text: "four" },
        ],
      },
      {
        oldStart: 20,
        newStart: 21,
        lines: [
          { kind: "added", text: "added" },
          { kind: "added", text: "more" },
        ],
      },
    ]);
  });

  it("says when git has no lines to show", () => {
    expect(parseDiff("diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n")).toEqual({
      hunks: [],
      binary: true,
    });
    expect(parseDiff("")).toEqual({ hunks: [], binary: false });
  });

  it("cuts a long diff where it is told to", () => {
    const hunk = (count: number) => ({
      oldStart: 1,
      newStart: 1,
      lines: Array.from({ length: count }, () => ({ kind: "added" as const, text: "x" })),
    });
    expect(limitHunks([hunk(3), hunk(3)], 10)).toEqual({ hunks: [hunk(3), hunk(3)], truncated: false });
    const cut = limitHunks([hunk(3), hunk(3)], 4);
    expect(cut.truncated).toBe(true);
    expect(cut.hunks.map((each) => each.lines.length)).toEqual([3, 1]);
    expect(limitHunks([hunk(3), hunk(3)], 3).hunks).toHaveLength(1);
  });
});

describe("reading text", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("reads UTF-8, with or without its byte order mark", () => {
    expect(decodeText(bytes("héllo\nwörld"), false)).toBe("héllo\nwörld");
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("hi")]), false)).toBe("hi");
  });

  it("reads UTF-16 that says so", () => {
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]), false)).toBe("hi");
    expect(decodeText(new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]), false)).toBe("hi");
  });

  it("reads legacy text as Windows-1252", () => {
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), false)).toBe("café");
  });

  it("calls anything with NUL bytes or mostly control characters binary", () => {
    expect(decodeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), false)).toBeUndefined();
    expect(
      decodeText(new Uint8Array(Array.from({ length: 200 }, (_, index) => 1 + (index % 7))), false),
    ).toBeUndefined();
    expect(decodeText(new Uint8Array(), false)).toBe("");
  });

  it("drops a character a cut left half-read", () => {
    const whole = bytes("a€");
    expect(whole).toHaveLength(4);
    expect(withoutPartialCharacter(whole.subarray(0, 3))).toHaveLength(1);
    expect(withoutPartialCharacter(whole)).toHaveLength(4);
    expect(decodeText(whole.subarray(0, 2), true)).toBe("a");
    expect(decodeText(whole.subarray(0, 3), true)).toBe("a");
  });
});

/** Node takes a watcher's `ignore` from 24.14; before, it watches everything and only the classifiers drop it. */
const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
const watchTakesIgnore = nodeMajor === 24 ? nodeMinor >= 14 : nodeMajor > 24;

// A real repository, as the service sees one.
const TestLayer = Files.layer.pipe(Layer.provide(Git.layer), Layer.provideMerge(NodeServices.layer));

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

  // Making a link on Windows takes a right most accounts don't have.
  it.effect.skipIf(process.platform === "win32")(
    "lists a link as what it leads to, or a file when it's broken",
    () =>
      Effect.gen(function* () {
        const files = yield* Files;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(path.join(root, "real"));
        yield* fs.writeFileString(path.join(root, "real.txt"), "x");
        yield* fs.symlink(path.join(root, "real"), path.join(root, "to-folder"));
        yield* fs.symlink(path.join(root, "real.txt"), path.join(root, "to-file"));
        yield* fs.symlink(path.join(root, "gone"), path.join(root, "broken"));
        yield* fs.symlink(path.join(root, "real"), path.join(root, "node_modules"));
        const listing = yield* files.list(root, "");
        assert.deepStrictEqual(listing.entries, [
          { name: "node_modules", folder: true, link: true, heavy: true },
          { name: "real", folder: true },
          { name: "to-folder", folder: true, link: true },
          { name: "broken", folder: false, link: true },
          { name: "real.txt", folder: false },
          { name: "to-file", folder: false, link: true },
        ]);
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

  it.effect("reads text, cuts a long file, and tells media, binary and missing files apart", () =>
    Effect.gen(function* () {
      const files = yield* Files;
      const { root, write, fs, path } = yield* repository;
      const text = yield* files.read(root, "README.md");
      assert.deepStrictEqual(text, { _tag: "Text", text: "# Title\n\nHello\n", size: 15, truncated: false });

      yield* write("big.txt", "line of text\n".repeat(200_000));
      const big = yield* files.read(root, "big.txt");
      assert.strictEqual(big._tag, "Text");
      if (big._tag === "Text") {
        assert.isTrue(big.truncated);
        assert.strictEqual(big.text.length, PREVIEW_BYTES);
      }

      yield* write("logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>");
      assert.strictEqual((yield* files.read(root, "logo.svg"))._tag, "Text");

      yield* fs.writeFile(path.join(root, "blob.bin"), new Uint8Array([1, 2, 0, 3, 255, 0, 9]));
      assert.deepStrictEqual(yield* files.read(root, "blob.bin"), { _tag: "Binary", size: 7 });
      assert.deepStrictEqual(yield* files.read(root, "nope.txt"), { _tag: "Missing" });

      yield* fs.writeFile(path.join(root, "pic.png"), new Uint8Array([137, 80, 78, 71]));
      assert.deepStrictEqual(yield* files.read(root, "pic.png"), {
        _tag: "Media",
        kind: "image",
        mediaType: "image/png",
        size: 4,
      });
      yield* fs.writeFile(path.join(root, "clip.mp4"), new Uint8Array(10));
      assert.deepStrictEqual(yield* files.read(root, "clip.mp4"), {
        _tag: "Media",
        kind: "video",
        mediaType: "video/mp4",
        size: 10,
      });

      assert.isTrue(Exit.isFailure(yield* Effect.exit(files.read(root, "../outside.txt"))));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(files.read(root, "src"))));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("streams a file's bytes in pieces that put it back together", () =>
    Effect.gen(function* () {
      const files = yield* Files;
      const { root, fs, path } = yield* repository;
      const bytes = Uint8Array.from({ length: BYTES_CHUNK * 2 + 123 }, (_, index) => (index * 7) % 256);
      yield* fs.writeFile(path.join(root, "song.mp3"), bytes);
      const pieces = yield* files.readBytes(root, "song.mp3").pipe(Stream.runCollect);
      assert.isAbove(pieces.length, 1);
      const joined = Buffer.concat(pieces.map((piece) => Buffer.from(piece.data, "base64")));
      assert.isTrue(joined.equals(Buffer.from(bytes)));

      for (const bad of ["../outside.mp3", "missing.mp3", "src"]) {
        const exit = yield* Effect.exit(files.readBytes(root, bad).pipe(Stream.runDrain));
        assert.isTrue(Exit.isFailure(exit), bad);
      }
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "diffs a changed file against the last commit, shows new files whole, and widens on request",
    () =>
      Effect.gen(function* () {
        const files = yield* Files;
        const { root, write, fs, path } = yield* repository;
        yield* write("src/app.ts", "one\nTWO\nthree\nfour\n");
        const changed = yield* files.diff(root, "src/app.ts");
        assert.deepStrictEqual(changed.hunks, [
          {
            oldStart: 1,
            newStart: 1,
            lines: [
              { kind: "context", text: "one" },
              { kind: "removed", text: "two" },
              { kind: "added", text: "TWO" },
              { kind: "context", text: "three" },
              { kind: "context", text: "four" },
            ],
          },
        ]);
        const tight = yield* files.diff(root, "src/app.ts", undefined, 0);
        assert.deepStrictEqual(tight.hunks[0]?.lines, [
          { kind: "removed", text: "two" },
          { kind: "added", text: "TWO" },
        ]);

        const long = Array.from({ length: 30 }, (_, index) => `line ${index}`);
        yield* write("long.txt", `${long.join("\n")}\n`);
        yield* git(root, "add", "long.txt");
        yield* git(root, "commit", "-q", "-m", "long");
        yield* write(
          "long.txt",
          `${long.map((line, index) => (index === 15 ? "middle" : line)).join("\n")}\n`,
        );
        assert.strictEqual((yield* files.diff(root, "long.txt")).hunks[0]?.lines.length, 8);
        const whole = yield* files.diff(root, "long.txt", undefined, 100_000);
        assert.strictEqual(whole.hunks.length, 1);
        assert.strictEqual(whole.hunks[0]?.lines.length, 31);

        yield* write("fresh.ts", "a\nb\n");
        const fresh = yield* files.diff(root, "fresh.ts");
        assert.deepStrictEqual(fresh.hunks, [
          {
            oldStart: 0,
            newStart: 1,
            lines: [
              { kind: "added", text: "a" },
              { kind: "added", text: "b" },
            ],
          },
        ]);

        yield* fs.remove(path.join(root, "gone.txt"));
        const gone = yield* files.diff(root, "gone.txt");
        assert.deepStrictEqual(gone.hunks[0]?.lines, [{ kind: "removed", text: "bye" }]);

        yield* git(root, "mv", "README.md", "READ.md");
        yield* write("READ.md", "# Title\n\nHello!\n");
        const moved = yield* files.diff(root, "READ.md", "README.md");
        assert.deepStrictEqual(
          moved.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind !== "context")),
          [
            { kind: "removed", text: "Hello" },
            { kind: "added", text: "Hello!" },
          ],
        );

        assert.deepStrictEqual((yield* files.diff(root, "src/old.ts")).hunks, []);
        assert.isTrue(Exit.isFailure(yield* Effect.exit(files.diff(root, "../outside.txt"))));
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("tells the explorer what changes while it watches, in a batch", () =>
    Effect.gen(function* () {
      const files = yield* Files;
      const { root, write } = yield* repository;
      // Separate writes can straddle the batching window on a busy runner.
      const watching = yield* files.watch(root).pipe(
        Stream.scan(
          () => ({ paths: [] as string[], status: false }),
          (seen, batch) => ({
            paths: [...new Set([...seen.paths, ...batch.paths])],
            status: seen.status || batch.status,
          }),
        ),
        Stream.filter((batch) => batch.paths.includes("src/app.ts") && batch.paths.includes("debug.log")),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.sleep("300 millis");
      yield* write("src/app.ts", "changed\n");
      yield* write("node_modules/dep/more.js", "ignored");
      yield* write("debug.log", "ignored too");
      const [batch] = yield* Fiber.join(watching).pipe(Effect.timeout("10 seconds"));
      assert.isDefined(batch);
      assert.isTrue(batch!.paths.includes("src/app.ts"));
      assert.isTrue(batch!.paths.includes("debug.log"));
      assert.isFalse(batch!.paths.some((path) => path.startsWith("node_modules/")));
      // The one change git sees reports a change of status.
      assert.isTrue(batch!.status);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live("tells what a worktree's git does, though its git folder is elsewhere", () =>
    Effect.gen(function* () {
      const files = yield* Files;
      const { root, fs, path } = yield* repository;
      const worktree = path.join(yield* fs.makeTempDirectoryScoped(), "wt");
      yield* git(root, "worktree", "add", "-q", "-b", "side", worktree);
      yield* fs.writeFileString(path.join(worktree, "README.md"), "# Changed\n");
      yield* Effect.sleep("300 millis");
      const watching = yield* files.watch(worktree).pipe(
        Stream.filter((batch) => batch.refs === true),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Effect.sleep("300 millis");
      yield* git(worktree, "commit", "-q", "-am", "second");
      const [batch] = yield* Fiber.join(watching).pipe(Effect.timeout("10 seconds"));
      assert.isDefined(batch);
      assert.isTrue(batch!.status);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.live.skipIf(!watchTakesIgnore)(
    "never hears from inside dependencies or git's objects, while the rest and the refs report",
    () =>
      Effect.gen(function* () {
        const { root, write, fs, path } = yield* repository;
        yield* fs.makeDirectory(path.join(root, "node_modules", "dep"), { recursive: true });
        // What the OS reports to a watcher told what the explorer skips, before anything classifies it.
        const reported = Stream.callback<string>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() =>
              watch(root, { recursive: true, ignore: watchSkips }, (_event, name) => {
                if (name !== null) Queue.offerUnsafe(queue, name.replaceAll("\\", "/"));
              }),
            ),
            (watcher) => Effect.sync(() => watcher.close()),
          ),
        );
        const watching = yield* reported.pipe(
          Stream.takeUntil((name) => name === ".git/refs/heads/main"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Effect.sleep("300 millis");
        yield* write("node_modules/dep/more.js", "unseen");
        yield* write("src/app.ts", "changed\n");
        yield* git(root, "commit", "-q", "-am", "second");
        const names = yield* Fiber.join(watching).pipe(Effect.timeout("10 seconds"));
        assert.include(names, "src/app.ts");
        assert.isFalse(names.some((name) => name.startsWith("node_modules/")));
        assert.isFalse(
          names.some((name) => name.startsWith(".git/objects/") || name.startsWith(".git/logs/")),
        );
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
