import { Checkpoints } from "@cerium/orchestrator";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Context, Effect, Fiber, FileSystem, Layer, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { createHash } from "node:crypto";

import { checkpointsLayer, maintainCheckpoints, parseNameStatus, parseNumstat } from "../src/checkpoints.ts";
import { DIFF_BYTES } from "../src/files.ts";

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

/** A snapshot of `folder` as an older Cerium kept it: in the folder's own store under `home`. */
const keptByOlderCerium = (folder: string, home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const resolved = path.resolve(folder);
    const store = path.join(
      home,
      createHash("sha256")
        .update(process.platform === "win32" ? resolved.toLowerCase() : resolved)
        .digest("hex")
        .slice(0, 20),
    );
    const oldGit = (args: ReadonlyArray<string>) =>
      spawner.string(
        ChildProcess.make(
          "git",
          [`--git-dir=${store}`, `--work-tree=${folder}`, "-c", "core.autocrlf=false", ...args],
          { cwd: folder, env: { GIT_INDEX_FILE: path.join(store, "index") }, extendEnv: true },
        ),
      );
    yield* spawner.string(ChildProcess.make("git", ["init", "--quiet", "--bare", store], { cwd: home }));
    yield* fs.writeFileString(path.join(store, "info", "exclude"), "node_modules/\n");
    yield* oldGit(["add", "--all", "--", "."]);
    const old = (yield* oldGit(["write-tree"])).trim();
    return { store, oldGit, old };
  });

/** What `store`'s own object folder and its `pack` folder hold. */
const ownObjects = (store: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const objects = path.join(store, "objects");
    return [
      (yield* fs.readDirectory(objects)).toSorted(),
      yield* fs.readDirectory(path.join(objects, "pack")),
    ];
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

  it.effect("reads no more of a huge file's diff than the viewer is sent, cut at a whole line", () =>
    Effect.gen(function* () {
      const { folder, write, checkpoints } = yield* setup;
      const before = yield* checkpoints.save(folder);
      const line = "x".repeat(1_000);
      yield* write("big.txt", `${line}\n`.repeat(12_000));
      const after = yield* checkpoints.save(folder);
      const diff = yield* checkpoints.diff(folder, before, after, "big.txt", 3);
      assert.isAtLeast(diff.length, DIFF_BYTES / 2);
      assert.isBelow(diff.length, 2 * DIFF_BYTES);
      assert.isTrue(diff.endsWith(`+${line}\n`));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("serves many saves of one folder at once with one or two runs of git, past a stale lock", () =>
    Effect.gen(function* () {
      const { folder, home, write, checkpoints, fs, path } = yield* setup;
      const first = yield* checkpoints.save(folder);
      // A git stopped mid-save by an older Cerium left the store's index locked.
      const [store] = (yield* fs.readDirectory(home)).filter((name) => name !== "shared");
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

  // Live: the watcher's reports come in real time.
  it.live("serves a reusing save from the last snapshot until something in the folder changes", () =>
    Effect.gen(function* () {
      const { fs, path, folder, home, write } = yield* setup;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      let runs = 0;
      const counted = ChildProcessSpawner.make((command) => {
        runs += 1;
        return spawner.spawn(command);
      });
      const checkpoints = Context.get(
        yield* Layer.build(checkpointsLayer({ directory: path.join(home, "counted") })).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, counted),
        ),
        Checkpoints,
      );
      // The OS reports changes a moment after they happen.
      const settle = Effect.sleep("300 millis");
      const first = yield* checkpoints.save(folder, { reuse: true });
      yield* settle;
      const ran = runs;
      assert.strictEqual(yield* checkpoints.save(folder, { reuse: true }), first);
      assert.strictEqual(runs, ran);

      // What snapshots leave out doesn't count as a change.
      yield* write("node_modules/dep/index.js", "upgraded\n");
      yield* write(".git/scratch", "git's own\n");
      yield* settle;
      assert.strictEqual(yield* checkpoints.save(folder, { reuse: true }), first);
      assert.strictEqual(runs, ran);

      yield* write("src/a.ts", "changed\n");
      yield* settle;
      const second = yield* checkpoints.save(folder, { reuse: true });
      assert.notStrictEqual(second, first);
      yield* fs.remove(path.join(folder, "src/b.ts"));
      yield* settle;
      const third = yield* checkpoints.save(folder, { reuse: true });
      assert.notStrictEqual(third, second);
      // A save that doesn't ask to reuse always reads the folder.
      const before = runs;
      assert.strictEqual(yield* checkpoints.save(folder), third);
      assert.isAbove(runs, before);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps what several folders hold once, in the store they share", () =>
    Effect.gen(function* () {
      const { folder, home, checkpoints, fs, path, read } = yield* setup;
      // Another worktree of the same repository: the same files.
      const other = yield* fs.makeTempDirectoryScoped();
      yield* fs.copy(folder, other);
      const looseIn = (objects: string) =>
        Effect.gen(function* () {
          const prefixes = (yield* fs.readDirectory(objects)).filter((name) => /^[0-9a-f]{2}$/.test(name));
          let count = 0;
          for (const prefix of prefixes)
            count += (yield* fs.readDirectory(path.join(objects, prefix))).length;
          return count;
        });
      const shared = path.join(home, "shared", "objects");

      const mine = yield* checkpoints.save(folder);
      const kept = yield* looseIn(shared);
      assert.isAbove(kept, 0);
      assert.strictEqual(yield* checkpoints.save(other), mine);
      assert.strictEqual(yield* looseIn(shared), kept);
      // Neither folder's own store keeps an object.
      for (const name of (yield* fs.readDirectory(home)).filter((name) => name !== "shared")) {
        assert.strictEqual(yield* looseIn(path.join(home, name, "objects")), 0);
      }

      yield* fs.writeFileString(path.join(other, "src/a.ts"), "theirs\n");
      const theirs = yield* checkpoints.save(other);
      yield* checkpoints.restore(other, mine, ["src/a.ts"]);
      assert.strictEqual(yield* fs.readFileString(path.join(other, "src/a.ts")), "one\r\n");
      assert.deepStrictEqual(yield* checkpoints.changes(other, mine, theirs), [
        { path: "src/a.ts", change: "modified" },
      ]);
      assert.strictEqual(yield* read("src/a.ts"), "one\r\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reads an older Cerium's store, then moves its objects to the shared one and still reads them",
    () =>
      Effect.gen(function* () {
        const { folder, home, write, read, checkpoints } = yield* setup;
        const { store, oldGit, old } = yield* keptByOlderCerium(folder, home);

        yield* write("src/a.ts", "changed\n");
        const now = yield* checkpoints.save(folder);
        assert.deepStrictEqual(yield* checkpoints.changes(folder, old, now), [
          { path: "src/a.ts", change: "modified" },
        ]);

        yield* maintainCheckpoints({ directory: home });
        // Nothing but where to find them is left in the folder's own store.
        assert.deepStrictEqual(yield* ownObjects(store), [["info", "pack"], []]);
        assert.deepStrictEqual(yield* checkpoints.changes(folder, old, now), [
          { path: "src/a.ts", change: "modified" },
        ]);
        yield* checkpoints.restore(folder, old, ["src/a.ts"]);
        assert.strictEqual(yield* read("src/a.ts"), "one\r\n");
        // Git run on the store by hand, or by an older Cerium, still finds them.
        assert.strictEqual((yield* oldGit(["cat-file", "-t", old])).trim(), "tree");
        assert.strictEqual((yield* oldGit(["cat-file", "-t", now])).trim(), "tree");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("packs the shared store without losing a snapshot no ref points at", () =>
    Effect.gen(function* () {
      const { folder, home, write, read, checkpoints, fs, path } = yield* setup;
      const objects = path.join(home, "shared", "objects");
      const maintain = maintainCheckpoints({ directory: home, looseLimit: 1, packLimit: 3 });
      const packs = () =>
        fs
          .readDirectory(path.join(objects, "pack"))
          .pipe(Effect.map((names) => names.filter((name) => name.endsWith(".pack")).length));
      const trees: Array<string> = [];
      for (const version of ["v1", "v2", "v3"]) {
        yield* write("src/a.ts", `${version}\n`);
        trees.push(yield* checkpoints.save(folder));
        yield* maintain;
        // Every loose object went into a pack.
        assert.deepStrictEqual(
          (yield* fs.readDirectory(objects)).filter((name) => /^[0-9a-f]{2}$/.test(name)).length,
          0,
        );
      }
      // Three packs were made into one.
      assert.strictEqual(yield* packs(), 1);
      // What an earlier pass was stopped in the middle of goes once it's old, never while git may still
      // be writing it.
      const leftover = (name: string, hoursAgo: number) =>
        Effect.gen(function* () {
          const file = path.join(objects, "pack", name);
          yield* fs.writeFileString(file, "");
          const then = new Date(Date.now() - hoursAgo * 3_600_000);
          yield* fs.utimes(file, then, then);
          return file;
        });
      const stale = [
        yield* leftover(`pack-${"a".repeat(40)}.pack`, 2),
        yield* leftover(`pack-${"a".repeat(40)}.rev`, 2),
        yield* leftover("tmp_pack_stale", 2),
      ];
      const fresh = [yield* leftover(`pack-${"b".repeat(40)}.pack`, 0), yield* leftover("tmp_pack_fresh", 0)];
      yield* maintain;
      assert.strictEqual(yield* packs(), 2);
      for (const file of stale) assert.isFalse(yield* fs.exists(file));
      for (const file of fresh) assert.isTrue(yield* fs.exists(file));

      assert.deepStrictEqual(yield* checkpoints.changes(folder, trees[0]!, trees[2]!), [
        { path: "src/a.ts", change: "modified" },
      ]);
      yield* checkpoints.restore(folder, trees[0]!, ["src/a.ts"]);
      assert.strictEqual(yield* read("src/a.ts"), "v1\n");
      assert.strictEqual(yield* checkpoints.save(folder), trees[0]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves an older store's objects where they are when the shared store can't take them all", () =>
    Effect.gen(function* () {
      const { folder, home, checkpoints, fs, path } = yield* setup;
      const tree = yield* checkpoints.save(folder);
      const [name] = (yield* fs.readDirectory(home)).filter((entry) => entry !== "shared");
      const own = path.join(home, name!, "objects");
      // A damaged object in the folder's own store, as an older Cerium might have left one.
      yield* fs.makeDirectory(path.join(own, "ab"));
      const damaged = path.join(own, "ab", "c".repeat(38));
      yield* fs.writeFileString(damaged, "not an object");

      yield* maintainCheckpoints({ directory: home });
      assert.isTrue(yield* fs.exists(damaged));
      assert.deepStrictEqual(yield* checkpoints.changes(folder, tree, tree), []);
      assert.strictEqual(yield* checkpoints.save(folder), tree);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps every snapshot while saves and restores run beside maintenance", () =>
    Effect.gen(function* () {
      const { folder, home, write, read, checkpoints } = yield* setup;
      const { store, old } = yield* keptByOlderCerium(folder, home);
      const trees: Array<string> = [];
      const work = Effect.gen(function* () {
        for (let version = 0; version < 6; version++) {
          yield* write("src/a.ts", `v${version}\n`);
          trees.push(yield* checkpoints.save(folder));
          // Reads the older store's objects as maintenance moves them.
          yield* checkpoints.restore(folder, old, ["src/b.ts"]);
        }
      });
      const maintain = maintainCheckpoints({ directory: home, looseLimit: 1, packLimit: 2 });
      yield* Effect.all([work, Effect.forEach([1, 2, 3, 4], () => maintain, { discard: true })], {
        concurrency: "unbounded",
      });
      yield* maintainCheckpoints({ directory: home });

      assert.deepStrictEqual(yield* ownObjects(store), [["info", "pack"], []]);
      for (const tree of trees) {
        assert.deepStrictEqual(yield* checkpoints.changes(folder, old, tree), [
          { path: "src/a.ts", change: "modified" },
        ]);
      }
      yield* checkpoints.restore(folder, trees[0]!, ["src/a.ts"]);
      assert.strictEqual(yield* read("src/a.ts"), "v0\n");
      yield* checkpoints.restore(folder, old, ["src/a.ts"]);
      assert.strictEqual(yield* read("src/a.ts"), "one\r\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Live: maintenance is stopped after real time has passed, at whatever step it reached.
  it.live("keeps every snapshot when maintenance is stopped part way, and finishes the next time", () =>
    Effect.gen(function* () {
      const { folder, home, write, read, checkpoints } = yield* setup;
      const { store, old } = yield* keptByOlderCerium(folder, home);
      for (const delay of [0, 20, 60, 150, 300]) {
        yield* write("src/a.ts", `stopped after ${delay}\n`);
        const now = yield* checkpoints.save(folder);
        const fiber = yield* Effect.forkChild(
          maintainCheckpoints({ directory: home, looseLimit: 1, packLimit: 2 }),
        );
        yield* Effect.sleep(delay);
        yield* Fiber.interrupt(fiber);
        assert.deepStrictEqual(yield* checkpoints.changes(folder, old, now), [
          { path: "src/a.ts", change: "modified" },
        ]);
      }
      yield* maintainCheckpoints({ directory: home });
      assert.deepStrictEqual(yield* ownObjects(store), [["info", "pack"], []]);
      yield* checkpoints.restore(folder, old, ["src/a.ts"]);
      assert.strictEqual(yield* read("src/a.ts"), "one\r\n");
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
