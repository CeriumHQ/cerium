import { Checkpoints } from "@cerium/orchestrator";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { checkpointsLayer, parseNameStatus, parseNumstat } from "../src/checkpoints.ts";

describe("parseNameStatus", () => {
  it("reads each file's change from git's NUL-separated list", () => {
    expect(parseNameStatus("")).toEqual([]);
    expect(parseNameStatus("M\0a.ts\0A\0dir/new file.ts\0D\0gone.txt\0")).toEqual([
      { path: "a.ts", change: "modified" },
      { path: "dir/new file.ts", change: "added" },
      { path: "gone.txt", change: "deleted" },
    ]);
  });
});

describe("parseNumstat", () => {
  it("reads each file's lines from git's NUL-separated list, none for one that isn't text", () => {
    expect(parseNumstat("")).toEqual([]);
    expect(parseNumstat("3\t0\ta.ts\0-\t-\timage.png\0")).toEqual([
      { path: "a.ts", added: 3, removed: 0 },
      { path: "image.png" },
    ]);
    expect(parseNumstat("0\t12\tdir/with\ttab.ts\0")).toEqual([
      { path: "dir/with\ttab.ts", added: 0, removed: 12 },
    ]);
  });
});

/** A folder with files, an ignored file and a repository of its own, and a home for snapshot stores. */
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = yield* fs.makeTempDirectoryScoped();
  const home = yield* fs.makeTempDirectoryScoped();
  const write = (name: string, text: string) =>
    fs
      .makeDirectory(path.dirname(path.join(folder, name)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(folder, name), text)));
  const read = (name: string) => fs.readFileString(path.join(folder, name));
  const exists = (name: string) => fs.exists(path.join(folder, name));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* spawner.string(ChildProcess.make("git", ["init", "-q", "-b", "main"], { cwd: folder }));
  yield* write(".gitignore", "secret.txt\n");
  yield* write("src/a.ts", "one\r\n");
  yield* write("src/b.ts", "two\n");
  yield* write("secret.txt", "kept\n");
  yield* write("node_modules/dep/index.js", "dependency\n");
  // Built in the test's scope: saves run in the layer's, which must outlive them.
  const checkpoints = Context.get(yield* Layer.build(checkpointsLayer({ directory: home })), Checkpoints);
  return { fs, path, folder, home, write, read, exists, checkpoints, spawner };
});

describe("Checkpoints", () => {
  it.effect("puts back the files it is asked to, as a snapshot held them, and no others", () =>
    Effect.gen(function* () {
      const { folder, write, read, exists, checkpoints, fs, path } = yield* setup;
      const before = yield* checkpoints.save(folder);
      // Saving an unchanged folder gives the same snapshot.
      assert.strictEqual(yield* checkpoints.save(folder), before);

      yield* write("src/a.ts", "changed\n");
      yield* fs.remove(path.join(folder, "src/b.ts"));
      yield* write("src/c.ts", "new\n");
      yield* write("other.ts", "someone else's\n");
      yield* write("secret.txt", "changed too\n");
      yield* write("node_modules/dep/index.js", "upgraded\n");
      const after = yield* checkpoints.save(folder);

      assert.deepStrictEqual(
        (yield* checkpoints.lines(folder, before, after)).toSorted((a, b) => a.path.localeCompare(b.path)),
        [
          { path: "other.ts", added: 1, removed: 0 },
          { path: "src/a.ts", added: 1, removed: 1 },
          { path: "src/b.ts", added: 0, removed: 1 },
          { path: "src/c.ts", added: 1, removed: 0 },
        ],
      );
      const diff = yield* checkpoints.diff(folder, before, after, "src/a.ts", 3);
      assert.include(diff, "-one\r\n+changed");
      assert.notInclude(diff, "src/c.ts");

      const changes = yield* checkpoints.changes(folder, before, after);
      // Ignored files and dependencies are never saved, so they never differ.
      assert.deepStrictEqual(
        changes.toSorted((a, b) => a.path.localeCompare(b.path)),
        [
          { path: "other.ts", change: "added" },
          { path: "src/a.ts", change: "modified" },
          { path: "src/b.ts", change: "deleted" },
          { path: "src/c.ts", change: "added" },
        ],
      );

      yield* checkpoints.restore(folder, before, ["src/a.ts", "src/b.ts", "src/c.ts"]);
      // Byte for byte, line endings included.
      assert.strictEqual(yield* read("src/a.ts"), "one\r\n");
      assert.strictEqual(yield* read("src/b.ts"), "two\n");
      assert.isFalse(yield* exists("src/c.ts"));
      // What it wasn't asked to put back stays as it is.
      assert.strictEqual(yield* read("other.ts"), "someone else's\n");
      assert.strictEqual(yield* read("secret.txt"), "changed too\n");
      assert.strictEqual(yield* read("node_modules/dep/index.js"), "upgraded\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("serves many saves of one folder at once with one or two runs of git, past a stale lock", () =>
    Effect.gen(function* () {
      const { folder, home, write, checkpoints, fs, path } = yield* setup;
      const first = yield* checkpoints.save(folder);
      // A git stopped mid-save by an older Cerium left the store's index locked.
      const [store] = yield* fs.readDirectory(home);
      yield* fs.writeFileString(path.join(home, store ?? "", "index.lock"), "");
      yield* write("src/a.ts", "changed\n");
      const trees = yield* Effect.all(
        Array.from({ length: 8 }, () => checkpoints.save(folder)),
        { concurrency: "unbounded" },
      );
      assert.strictEqual(new Set(trees).size, 1);
      assert.notStrictEqual(trees[0], first);
      // No copy of the index is left behind.
      const left = (yield* fs.readDirectory(path.join(home, store ?? ""))).filter((name) =>
        name.startsWith("index-"),
      );
      assert.deepStrictEqual(left, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves the folder's own repository untouched", () =>
    Effect.gen(function* () {
      const { folder, write, checkpoints, spawner } = yield* setup;
      const status = () =>
        spawner.string(
          ChildProcess.make("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: folder }),
        );
      const untouched = yield* status();
      yield* checkpoints.save(folder);
      yield* write("src/a.ts", "changed\n");
      const before = yield* checkpoints.save(folder);
      yield* checkpoints.restore(folder, before, ["src/a.ts"]);
      assert.strictEqual(yield* status(), untouched);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
