import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { PickedHunk } from "@cerium/rpc";

import { Git } from "../src/git.ts";
import {
  GitChanges,
  leadingFields,
  linePatch,
  parentFolders,
  parseStatusV2,
  rawHunks,
} from "../src/gitChanges.ts";
import { madeOnce, sameFolder } from "./repositories.ts";

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

  it("reads a status's first fields and says when there are more", () => {
    expect(leadingFields("a\0b\0c\0", 3)).toEqual({ text: "a\0b\0c\0", more: false });
    expect(leadingFields("a\0b\0c\0", 5)).toEqual({ text: "a\0b\0c\0", more: false });
    expect(leadingFields("a\0b\0c\0", 2)).toEqual({ text: "a\0b\0", more: true });
    expect(leadingFields("", 2)).toEqual({ text: "", more: false });
  });

  it("names the folders a path is in, nearest first", () => {
    expect(parentFolders("a/b/c.ts")).toEqual(["a/b", "a"]);
    expect(parentFolders("top.ts")).toEqual([]);
  });
});

describe("line patches", () => {
  const diff = [
    "diff --git a/f.txt b/f.txt",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1,4 +1,4 @@",
    " a",
    "-b",
    "+B",
    "+new\r",
    " c",
    " d",
    "@@ -10,2 +10,2 @@",
    " j",
    "-k",
    "\\ No newline at end of file",
    "+K",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  const hunks = rawHunks(diff);

  it("stages the picked lines and keeps the others as the index has them", () => {
    const patch = linePatch(
      "f.txt",
      hunks,
      [
        [false, true, false, true],
        [false, true, true],
      ],
      false,
    );
    expect(patch).toBe(
      [
        "diff --git a/f.txt b/f.txt",
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -1,4 +1,4 @@",
        " a",
        "-b",
        "+new\r",
        " c",
        " d",
        "@@ -10,2 +10,2 @@",
        " j",
        "-k",
        "\\ No newline at end of file",
        "+K",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
  });

  it("takes the picked lines out of the side they're on, moving the hunks after them", () => {
    // Unpicking `-b` drops it; unpicking `+B` keeps it as a line the index has.
    const patch = linePatch(
      "f.txt",
      hunks,
      [
        [false, false, false, true],
        [false, true, true],
      ],
      true,
    );
    expect(patch?.split("\n").slice(3)).toEqual([
      "@@ -1,4 +1,5 @@",
      " a",
      " B",
      "+new\r",
      " c",
      " d",
      "@@ -9,2 +10,2 @@",
      " j",
      "-k",
      "\\ No newline at end of file",
      "+K",
      "\\ No newline at end of file",
      "",
    ]);
  });

  it("leaves out hunks with nothing picked, and makes nothing of no picks", () => {
    expect(linePatch("f.txt", hunks, [[], [false, true, true]], false)?.split("\n")[3]).toBe(
      "@@ -10,2 +10,2 @@",
    );
    expect(linePatch("f.txt", hunks, [[true, false, false, false, true]], false)).toBeUndefined();
  });

  it("quotes a path the way git does when it holds a quote or a tab", () => {
    const patch = linePatch('a "b"\tc.txt', hunks, [[false, true]], false);
    expect(patch?.split("\n")[0]).toBe('diff --git "a/a \\"b\\"\\tc.txt" "b/a \\"b\\"\\tc.txt"');
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

/** A repository on `main` whose first commit holds `.gitignore`, `src/app.ts` and `README.md`. */
const first = madeOnce(
  Effect.fn("first")(function* (root: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* git(root, "init", "-q", "-b", "main");
    yield* git(root, "config", "core.autocrlf", "false");
    yield* git(root, "config", "user.name", "Test");
    yield* git(root, "config", "user.email", "test@example.com");
    // The machine's own settings stay out of it: no signing, and only the repository's own hooks.
    yield* git(root, "config", "commit.gpgsign", "false");
    yield* git(root, "config", "core.hooksPath", ".git/hooks");
    yield* fs.makeDirectory(path.join(root, "src"));
    yield* fs.writeFileString(path.join(root, ".gitignore"), "*.log\n");
    yield* fs.writeFileString(
      path.join(root, "src", "app.ts"),
      "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
    );
    yield* fs.writeFileString(path.join(root, "README.md"), "# Title\n");
    yield* git(root, "add", "-A");
    yield* git(root, "commit", "-q", "-m", "first");
  }),
);

export const repository = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  const write = (name: string, text: string) =>
    fs
      .makeDirectory(path.dirname(path.join(root, name)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(root, name), text)));
  const read = (name: string) => fs.readFileString(path.join(root, name));
  yield* first(root);
  return { root, write, read, fs, path, git: (...args: Array<string>) => git(root, ...args) };
});

describe("GitChanges", () => {
  it.effect("lists the whole repository's changes from a folder inside it, relative to its top", () =>
    Effect.gen(function* () {
      const changes = yield* GitChanges;
      const { root, write, path, git } = yield* repository;
      yield* write("src/app.ts", "one\n");
      yield* git("add", "src/app.ts");
      yield* write("src/app.ts", "one\nmore\n");
      yield* write("docs/new.md", "new\n");
      yield* write("debug.log", "ignored\n");
      const status = yield* changes.status(path.join(root, "src"));
      assert.isTrue(status.repository);
      assert.isTrue(sameFolder(root, status.top!));
      assert.deepStrictEqual(status.staged, [{ path: "src/app.ts", state: "modified" }]);
      assert.deepStrictEqual(status.unstaged, [
        { path: "docs/new.md", state: "untracked" },
        { path: "src/app.ts", state: "modified" },
      ]);
      assert.deepStrictEqual(status.conflicted, []);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("stages, unstages and discards a file, a folder or everything", () =>
    Effect.gen(function* () {
      const changes = yield* GitChanges;
      const { root, write, read, fs, path } = yield* repository;
      yield* write("src/app.ts", "changed\n");
      yield* write("src/new/fresh.ts", "fresh\n");
      yield* write("README.md", "# Changed\n");
      yield* write("src/debug.log", "ignored\n");
      const paths = (list: ReadonlyArray<{ readonly path: string }>) => list.map((change) => change.path);

      yield* changes.stage(root, ["src/"]);
      let status = yield* changes.status(root);
      assert.deepStrictEqual(paths(status.staged), ["src/app.ts", "src/new/fresh.ts"]);
      assert.deepStrictEqual(paths(status.unstaged), ["README.md"]);

      yield* changes.unstage(root, ["src/new/fresh.ts"]);
      status = yield* changes.status(root);
      assert.deepStrictEqual(paths(status.staged), ["src/app.ts"]);

      yield* changes.stage(root, [""]);
      assert.deepStrictEqual(paths((yield* changes.status(root)).staged), [
        "README.md",
        "src/app.ts",
        "src/new/fresh.ts",
      ]);
      yield* changes.unstage(root, [""]);
      assert.deepStrictEqual((yield* changes.status(root)).staged, []);

      // What's staged stays when what isn't goes.
      yield* changes.stage(root, ["README.md"]);
      yield* write("README.md", "# Changed again\n");
      yield* changes.discard(root, [""]);
      status = yield* changes.status(root);
      assert.deepStrictEqual(paths(status.staged), ["README.md"]);
      assert.deepStrictEqual(status.unstaged, []);
      assert.strictEqual(yield* read("README.md"), "# Changed\n");
      assert.strictEqual(
        yield* read("src/app.ts"),
        "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
      );
      assert.isFalse(yield* fs.exists(path.join(root, "src/new")));
      assert.isTrue(yield* fs.exists(path.join(root, "src/debug.log")));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("discards a new folder without touching the files git knows", () =>
    Effect.gen(function* () {
      const changes = yield* GitChanges;
      const { root, write, read, fs, path } = yield* repository;
      yield* write("src/app.ts", "changed\n");
      yield* write("docs/a.md", "a\n");
      yield* write("docs/deep/b.md", "b\n");
      yield* changes.discard(root, ["docs"]);
      assert.isFalse(yield* fs.exists(path.join(root, "docs")));
      assert.strictEqual(yield* read("src/app.ts"), "changed\n");
      // One new file whose folders held nothing else takes them along, up to a folder git knows.
      yield* write("src/new/deep/only.ts", "only\n");
      yield* changes.discard(root, ["src/new/deep/only.ts"]);
      assert.isFalse(yield* fs.exists(path.join(root, "src/new")));
      assert.isTrue(yield* fs.exists(path.join(root, "src")));
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("discards the files and folders it names, and only those", () =>
    Effect.gen(function* () {
      const changes = yield* GitChanges;
      const { root, write, read, fs, path } = yield* repository;
      yield* write("src/app.ts", "changed\n");
      yield* write("README.md", "# Changed\n");
      yield* write("docs/a.md", "a\n");
      yield* write("notes/b.md", "b\n");
      yield* changes.discard(root, ["README.md", "docs"]);
      assert.strictEqual(yield* read("README.md"), "# Title\n");
      assert.isFalse(yield* fs.exists(path.join(root, "docs")));
      assert.strictEqual(yield* read("src/app.ts"), "changed\n");
      assert.isTrue(yield* fs.exists(path.join(root, "notes/b.md")));
      assert.deepStrictEqual(
        (yield* changes.status(root)).unstaged.map((change) => change.path),
        ["notes/b.md", "src/app.ts"],
      );
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("unstages before the first commit", () =>
    Effect.gen(function* () {
      const changes = yield* GitChanges;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* git(root, "init", "-q");
      yield* fs.writeFileString(path.join(root, "a.txt"), "a\n");
      yield* changes.stage(root, ["a.txt"]);
      assert.strictEqual((yield* changes.status(root)).staged.length, 1);
      yield* changes.unstage(root, ["a.txt"]);
      const status = yield* changes.status(root);
      assert.deepStrictEqual(status.staged, []);
      assert.deepStrictEqual(status.unstaged, [{ path: "a.txt", state: "untracked" }]);
      assert.strictEqual(yield* changes.lastMessage(root), "");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("diffs each side of a file, and a new file whole", () =>
    Effect.gen(function* () {
      const changes = yield* GitChanges;
      const { root, write, git } = yield* repository;
      yield* write("README.md", "# Staged\n");
      yield* git("add", "README.md");
      yield* write("README.md", "# Unstaged\n");
      yield* write("new.txt", "new\n");
      const lines = (diff: { readonly hunks: ReadonlyArray<{ readonly lines: ReadonlyArray<unknown> }> }) =>
        diff.hunks.flatMap((hunk) => hunk.lines);
      assert.deepStrictEqual(lines(yield* changes.diff(root, "README.md", "staged")), [
        { kind: "removed", text: "# Title" },
        { kind: "added", text: "# Staged" },
      ]);
      assert.deepStrictEqual(lines(yield* changes.diff(root, "README.md", "unstaged")), [
        { kind: "removed", text: "# Staged" },
        { kind: "added", text: "# Unstaged" },
      ]);
      assert.deepStrictEqual(lines(yield* changes.diff(root, "new.txt", "unstaged")), [
        { kind: "added", text: "new" },
      ]);
      assert.deepStrictEqual(yield* changes.diff(root, "src/app.ts", "unstaged"), { hunks: [] });
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  /** `diff`'s hunks with the lines `pick` chooses picked. */
  const picking = (
    hunks: ReadonlyArray<{
      readonly oldStart: number;
      readonly newStart: number;
      readonly lines: ReadonlyArray<{
        readonly kind: "context" | "removed" | "added";
        readonly text: string;
      }>;
    }>,
    pick: (line: { readonly kind: string; readonly text: string }) => boolean,
  ): ReadonlyArray<PickedHunk> =>
    hunks.map((hunk) => ({ ...hunk, lines: hunk.lines.map((line) => ({ ...line, picked: pick(line) })) }));

  it.effect("stages, unstages and discards picked lines", () =>
    Effect.gen(function* () {
      const changes = yield* GitChanges;
      const { root, write, read, git } = yield* repository;
      const original = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
      yield* write("src/app.ts", "one\nTWO\nthree\nfour\nfive\nextra\nsix\nseven\neight\nnine\nten\n");
      const staged = () => git("show", ":src/app.ts");

      const unstaged = yield* changes.diff(root, "src/app.ts", "unstaged");
      yield* changes.applyLines(
        root,
        "src/app.ts",
        "stage",
        picking(unstaged.hunks, (line) => line.text.toLowerCase() === "two"),
      );
      assert.strictEqual(yield* staged(), original.replace("two", "TWO"));

      const stagedDiff = yield* changes.diff(root, "src/app.ts", "staged");
      yield* changes.applyLines(
        root,
        "src/app.ts",
        "unstage",
        picking(stagedDiff.hunks, (line) => line.kind === "added"),
      );
      // Unstaging only the new line leaves the old one's removal staged.
      assert.strictEqual(yield* staged(), original.replace("two\n", ""));
      yield* changes.unstage(root, ["src/app.ts"]);

      const again = yield* changes.diff(root, "src/app.ts", "unstaged");
      yield* changes.applyLines(
        root,
        "src/app.ts",
        "discard",
        picking(again.hunks, (line) => line.text === "extra"),
      );
      assert.strictEqual(yield* read("src/app.ts"), original.replace("two", "TWO"));
      assert.strictEqual(yield* staged(), original);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("keeps a file's line endings and its missing last newline", () =>
    Effect.gen(function* () {
      const changes = yield* GitChanges;
      const { root, write, git } = yield* repository;
      yield* write("crlf.txt", "a\r\nb\r\nc\r\n");
      yield* write("open.txt", "x\ny");
      yield* git("add", "-A");
      yield* git("commit", "-q", "-m", "files");
      yield* write("crlf.txt", "a\r\nB\r\nc\r\n");
      yield* write("open.txt", "x\nY");
      for (const file of ["crlf.txt", "open.txt"]) {
        const diff = yield* changes.diff(root, file, "unstaged");
        yield* changes.applyLines(
          root,
          file,
          "stage",
          picking(diff.hunks, (line) => line.kind !== "context"),
        );
      }
      assert.strictEqual(yield* git("show", ":crlf.txt"), "a\r\nB\r\nc\r\n");
      assert.strictEqual(yield* git("show", ":open.txt"), "x\nY");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("refuses lines picked in a diff that has changed since", () =>
    Effect.gen(function* () {
      const changes = yield* GitChanges;
      const { root, write } = yield* repository;
      yield* write("README.md", "# One\n");
      const diff = yield* changes.diff(root, "README.md", "unstaged");
      yield* write("README.md", "# Two\n");
      const error = yield* Effect.flip(
        changes.applyLines(
          root,
          "README.md",
          "stage",
          picking(diff.hunks, () => true),
        ),
      );
      assert.match(error.message, /changed since/);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("commits what's staged, everything, or amends the last commit", () =>
    Effect.gen(function* () {
      const changes = yield* GitChanges;
      const { root, write, git } = yield* repository;
      assert.match((yield* Effect.flip(changes.commit(root, "Nothing"))).message, /Nothing is staged/);
      yield* write("README.md", "# Changed\n");
      yield* write("new.txt", "new\n");
      yield* changes.stage(root, ["README.md"]);
      assert.match((yield* Effect.flip(changes.commit(root, "  "))).message, /Write a message/);

      const made = yield* changes.commit(root, "Change the title\n\nWith a body.");
      assert.strictEqual(made.subject, "Change the title");
      assert.strictEqual(yield* changes.lastMessage(root), "Change the title\n\nWith a body.");
      assert.deepStrictEqual((yield* changes.status(root)).staged, []);

      yield* changes.commit(root, "Add everything", { all: true });
      const status = yield* changes.status(root);
      assert.deepStrictEqual([status.staged, status.unstaged], [[], []]);

      yield* write("README.md", "# Amended\n");
      yield* changes.stage(root, ["README.md"]);
      const amended = yield* changes.commit(root, "", { amend: true });
      assert.strictEqual(amended.subject, "Add everything");
      assert.strictEqual((yield* git("rev-list", "--count", "HEAD")).trim(), "3");
      assert.strictEqual(yield* git("show", "HEAD:README.md"), "# Amended\n");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("says which hook stopped a commit, with what it printed", () =>
    Effect.gen(function* () {
      const changes = yield* GitChanges;
      const { root, write, fs, path } = yield* repository;
      const hook = path.join(root, ".git", "hooks", "pre-commit");
      yield* fs.makeDirectory(path.dirname(hook), { recursive: true });
      yield* fs.writeFileString(hook, "#!/bin/sh\necho 'lint: 2 problems' >&2\nexit 1\n");
      yield* fs.chmod(hook, 0o755);
      yield* write("README.md", "# Changed\n");
      yield* changes.stage(root, ["README.md"]);
      const error = yield* Effect.flip(changes.commit(root, "Blocked"));
      assert.strictEqual(error.message, "The pre-commit hook stopped the commit.");
      assert.include(error.output, "lint: 2 problems");
      assert.strictEqual((yield* changes.status(root)).staged.length, 1);
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
