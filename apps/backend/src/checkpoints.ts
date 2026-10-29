import { CheckpointError, Checkpoints, type SnapshotChange, type SnapshotLines } from "@cerium/orchestrator";
import { Deferred, Effect, Fiber, FileSystem, Layer, Option, Path, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createHash, randomUUID } from "node:crypto";
import { statSync, watch as watchFolder } from "node:fs";

import { DIFF_BYTES } from "./files.ts";

// Snapshots of work threads' folders, kept in git repositories of Cerium's own: a bare one per folder,
// whose index makes a snapshot of an unchanged tree cheap, and one object store they all write to,
// which keeps each version of a file once however many folders hold it, as a repository's worktrees
// do. The folder's own repository, if it has one, is never read or written: its `.gitignore` files
// still apply, since they sit in the folder.
//
// No git ref points at a snapshot: Cerium's events do. So nothing that drops what refs can't reach
// (`git gc`, `git prune`, `git repack -a -d`) ever runs on these stores; maintenance packs every
// object it finds, and removes a copy only once the shared store holds it elsewhere.

/** Left out of every snapshot, as no one restores them by hand: dependencies, caches and build output. */
export const DEFAULT_EXCLUDES: ReadonlyArray<string> = [
  "node_modules/",
  ".venv/",
  "venv/",
  "__pycache__/",
  ".gradle/",
  ".next/",
  ".turbo/",
  ".cache/",
  "target/",
];

const EXCLUDED = new Set(DEFAULT_EXCLUDES.map((pattern) => pattern.replace(/\/$/, "")));

const segmentsOf = (relative: string) => relative.split(/[\\/]/).filter((part) => part !== "");

/**
 * Whether the watcher can leave `relative`, a path under a snapshotted folder, and everything below
 * it unwatched: the folder's own repository and the folders every snapshot leaves out.
 */
export const snapshotSkips = (relative: string): boolean => {
  const segments = segmentsOf(relative);
  return segments[0] === ".git" || segments.some((part) => EXCLUDED.has(part));
};

/**
 * Whether a change the OS reports at `relative` under a snapshotted folder can't alter its next
 * snapshot: it lies inside what `snapshotSkips` leaves out. An excluded folder's own entry counts as
 * a change, as a file can share its name.
 */
export const outsideSnapshots = (relative: string): boolean => {
  const segments = segmentsOf(relative);
  return segments[0] === ".git" || segments.slice(0, -1).some((part) => EXCLUDED.has(part));
};

/**
 * How long a turn waits for its snapshot before starting without one. A folder's first save reads
 * every file, so it can take longer; it carries on, and the next save is quick.
 */
const WAIT_TIMEOUT = "15 seconds";

/** How long one save may run before it is stopped: a folder too big to save in that time gets none. */
const RUN_TIMEOUT = "5 minutes";

type Pending = Deferred.Deferred<string, CheckpointError>;

/** What a folder's watcher has seen since its last save began, and that save's snapshot. */
interface Watched {
  /** Something in the folder changed since the last save began, or the watcher can't say. */
  dirty: boolean;
  /** The last save's snapshot, once it finished. */
  tree?: string;
  readonly close: () => void;
}

/**
 * Git's settings for the snapshot store: files kept byte for byte, Windows' long paths allowed, and
 * nothing pruned, since a snapshot is referenced from Cerium's events rather than from git.
 */
const SETTINGS = [
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.safecrlf=false",
  "-c",
  "core.longpaths=true",
  "-c",
  "core.quotepath=false",
  "-c",
  "gc.auto=0",
  "-c",
  "core.fsmonitor=false",
];

/** The object store every folder's store writes to, beside them in the snapshots' directory. */
const SHARED = "shared";

/** A folder's own store, named for its path. */
const STORE_NAME = /^[0-9a-f]{20}$/;

/** Loose objects the shared store gathers before maintenance packs them. */
const LOOSE_LIMIT = 1_000;

/** Packs the shared store gathers before maintenance packs them into one. */
const PACK_LIMIT = 16;

/** How long the first maintenance waits after the app starts, so it doesn't slow the start. */
const MAINTENANCE_DELAY = "1 minute";

/** How long after one maintenance a save starts the next. */
const MAINTENANCE_INTERVAL = 10 * 60_000;

/** How old a pack left without its index must be before maintenance removes it, as git writes the pack first. */
const ORPHAN_AGE = 60 * 60_000;

/** `file` as git reads it in its environment and its alternates files: forward slashes on Windows. */
const gitPath = (file: string) => (process.platform === "win32" ? file.replaceAll("\\", "/") : file);

/** The lines of git's output, without the empty last one. */
const linesOf = (output: string) => output.split("\n").filter((line) => line !== "");

/** The files `git diff-tree -z --name-status` lists, as changes from its first tree to its second. */
export const parseNameStatus = (output: string): ReadonlyArray<SnapshotChange> => {
  const fields = output.split("\0");
  const changes: Array<SnapshotChange> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index]!;
    const path = fields[index + 1]!;
    if (path === "") continue;
    changes.push({
      path,
      change: status.startsWith("A") ? "added" : status.startsWith("D") ? "deleted" : "modified",
    });
  }
  return changes;
};

/**
 * The files `git diff-tree -z --numstat` lists, with the lines each gained and lost: `-` for both
 * when it isn't text.
 */
export const parseNumstat = (output: string): ReadonlyArray<SnapshotLines> => {
  const files: Array<SnapshotLines> = [];
  for (const entry of output.split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(entry);
    if (match === null) continue;
    const [, added, removed, path] = match;
    files.push(
      added === "-" || removed === "-"
        ? { path: path! }
        : { path: path!, added: Number(added), removed: Number(removed) },
    );
  }
  return files;
};

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  /** -1 when the output was cut at `limit`. */
  readonly code: number;
  /** Stdout went past the limit and was cut, and git was stopped. */
  readonly truncated: boolean;
}

interface GitOptions {
  readonly stdin?: string;
  /** The index file git uses, for commands that read or write one. */
  readonly index?: string;
  /** At most this many bytes of stdout are read; unlimited unless given. */
  readonly limit?: number;
}

interface RunOptions extends GitOptions {
  /** Where git runs. */
  readonly cwd: string;
  /** The repository: a folder's store, or the shared one. */
  readonly gitDir: string;
  /** The folder whose files a folder's store saves; none for maintenance, which reads no files. */
  readonly workTree?: string;
  /** Where git writes objects. */
  readonly objects: string;
  /** Where else git reads them from. */
  readonly alternates?: string;
}

type Spawner = ChildProcessSpawner.ChildProcessSpawner["Service"];

/** Runs git, failing only when it can't be started. */
const runGit = (spawner: Spawner, args: ReadonlyArray<string>, options: RunOptions) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          "git",
          [
            `--git-dir=${options.gitDir}`,
            ...(options.workTree === undefined ? [] : [`--work-tree=${options.workTree}`]),
            ...SETTINGS,
            ...args,
          ],
          {
            cwd: options.cwd,
            // Paths are names, never patterns: a file called `*.ts` restores only itself. Where objects
            // live is always set, so none of it comes from whoever started Cerium.
            env: {
              GIT_TERMINAL_PROMPT: "0",
              GIT_LITERAL_PATHSPECS: "1",
              GIT_OBJECT_DIRECTORY: gitPath(options.objects),
              GIT_ALTERNATE_OBJECT_DIRECTORIES:
                options.alternates === undefined ? "" : gitPath(options.alternates),
              ...(options.index === undefined ? {} : { GIT_INDEX_FILE: options.index }),
            },
            extendEnv: true,
            stdin:
              options.stdin === undefined
                ? "ignore"
                : Stream.succeed(new TextEncoder().encode(options.stdin)),
          },
        ),
      );
      // Stderr is read beside stdout; a git cut off mid-output never finishes it, and leaving the
      // scope stops both.
      const stderr = yield* Effect.forkScoped(Stream.mkString(Stream.decodeText(handle.stderr)));
      const limit = options.limit ?? Number.POSITIVE_INFINITY;
      let size = 0;
      const chunks = yield* handle.stdout.pipe(
        Stream.takeUntil((chunk) => (size += chunk.length) >= limit),
        Stream.runCollect,
      );
      const stdout = Buffer.concat(chunks).toString("utf8");
      if (size >= limit) return { stdout, stderr: "", code: -1, truncated: true } satisfies GitResult;
      const code = Number(yield* handle.exitCode);
      return { stdout, stderr: yield* Fiber.join(stderr), code, truncated: false } satisfies GitResult;
    }),
  ).pipe(
    Effect.mapError(
      () => new CheckpointError({ message: "Cerium couldn't run git. Is it installed and on the PATH?" }),
    ),
  );

/**
 * Git's output, failing with `message` when it exits with an error. Output cut at `limit` ends at its
 * last whole line.
 */
const runGitOk = (spawner: Spawner, args: ReadonlyArray<string>, message: string, options: RunOptions) =>
  runGit(spawner, args, options).pipe(
    Effect.flatMap((result) =>
      result.code === 0
        ? Effect.succeed(result.stdout)
        : result.truncated
          ? Effect.succeed(result.stdout.slice(0, result.stdout.lastIndexOf("\n") + 1))
          : Effect.logWarning(`git ${args[0]} failed in ${options.gitDir}: ${result.stderr.trim()}`).pipe(
              Effect.andThen(Effect.fail(new CheckpointError({ message }))),
            ),
    ),
  );

/** Makes the shared object store the first time it is needed. */
const ensureShared = Effect.fn("Checkpoints.ensureShared")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const shared = path.join(directory, SHARED);
  const made = () => fs.exists(path.join(shared, "HEAD")).pipe(Effect.orElseSucceed(() => false));
  if (yield* made()) return;
  yield* fs
    .makeDirectory(directory, { recursive: true })
    .pipe(Effect.mapError(() => new CheckpointError({ message: `Couldn't make ${directory}.` })));
  // Made aside and moved into place, so no one sees half a store: neither a save that starts meanwhile
  // nor another Cerium.
  const aside = path.join(directory, `${SHARED}-${randomUUID()}`);
  yield* runGitOk(spawner, ["init", "--quiet", "--bare"], "Couldn't make the snapshot store.", {
    cwd: directory,
    gitDir: aside,
    objects: path.join(aside, "objects"),
  });
  yield* fs.rename(aside, shared).pipe(
    Effect.catch(() =>
      fs.remove(aside, { recursive: true, force: true }).pipe(
        Effect.ignore,
        Effect.andThen(made()),
        Effect.flatMap((there) =>
          there
            ? Effect.void
            : Effect.fail(new CheckpointError({ message: "Couldn't make the snapshot store." })),
        ),
      ),
    ),
  );
});

/**
 * Keeps the snapshot stores under `directory` small without losing a snapshot: moves the objects an
 * older Cerium kept in each folder's store into the shared one, packs the shared store's loose objects
 * once there are `looseLimit` of them, and packs its packs into one once there are `packLimit`. No
 * object is dropped for being unreachable, and none is removed before the shared store holds it.
 */
export const maintainCheckpoints = Effect.fn("Checkpoints.maintain")(function* (options: {
  readonly directory: string;
  readonly looseLimit?: number;
  readonly packLimit?: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const shared = path.join(options.directory, SHARED);
  const objects = path.join(shared, "objects");
  const packs = path.join(objects, "pack");
  const failure = (message: string) => new CheckpointError({ message });
  const onShared = (args: ReadonlyArray<string>, message: string, more: Partial<RunOptions> = {}) =>
    runGitOk(spawner, args, message, { cwd: options.directory, gitDir: shared, objects, ...more });
  const list = (ids: ReadonlyArray<string>) => `${ids.join("\n")}\n`;

  /** Packs `ids` into a new pack in the shared store, reading them from `alternates` too; its name. */
  const pack = (ids: ReadonlyArray<string>, alternates?: string) =>
    onShared(["pack-objects", "--quiet", path.join(packs, "pack")], "Couldn't pack the snapshots.", {
      stdin: list(ids),
      ...(alternates === undefined ? {} : { alternates }),
    }).pipe(Effect.map((name) => `pack-${name.trim()}`));

  /** Those of `ids` the shared store doesn't hold itself. */
  const missing = (ids: ReadonlyArray<string>) =>
    onShared(["cat-file", "--batch-check=%(objectname)"], "Couldn't read the snapshot store.", {
      stdin: list(ids),
    }).pipe(
      Effect.map((output) =>
        linesOf(output)
          .filter((line) => line.endsWith(" missing"))
          .map((line) => line.slice(0, line.indexOf(" "))),
      ),
    );

  /** Every object `gitDir` keeps in `own`, and in any store `own` points to. */
  const objectsOf = (gitDir: string, own: string) =>
    runGitOk(
      spawner,
      ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"],
      "Couldn't read the snapshot store.",
      { cwd: options.directory, gitDir, objects: own },
    ).pipe(Effect.map(linesOf));

  /** The entries of `folder`, none when it can't be read. */
  const entries = (folder: string) => fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []));

  /**
   * Moves the objects an older Cerium kept in `store`, a folder's own store, into the shared one. They
   * are removed only once the shared store holds every one of them itself; until then the folder's
   * saves and restores read them where they are.
   */
  const adopt = Effect.fn("Checkpoints.adopt")(function* (store: string) {
    const own = path.join(store, "objects");
    // Its `pack` folder stays, as git makes it, emptied: Windows won't remove a folder git is reading.
    const held = [
      ...(yield* entries(own))
        .filter((name) => name !== "info" && name !== "pack")
        .map((name) => path.join(own, name)),
      ...(yield* entries(path.join(own, "pack"))).map((name) => path.join(own, "pack", name)),
    ];
    if (held.length === 0) return;
    const ids = yield* objectsOf(store, own);
    const absent = ids.length === 0 ? [] : yield* missing(ids);
    if (absent.length > 0) yield* pack(absent, own);
    if (ids.length > 0 && (yield* missing(ids)).length > 0) {
      return yield* failure("The shared store doesn't hold all of them.");
    }
    yield* pointAtShared(fs, path, store, objects);
    yield* Effect.forEach(held, (file) => fs.remove(file, { recursive: true, force: true }), {
      discard: true,
    }).pipe(Effect.mapError(() => failure("Couldn't remove the store's own copies.")));
    yield* Effect.logInfo(`Moved ${ids.length} snapshot objects from ${store} into the shared store`);
  });

  /** Removes `name`, a pack in the shared store: its index first, so git stops reading it. */
  const drop = (name: string) => {
    const stem = path.join(packs, name.slice(0, -".pack".length));
    return fs.remove(`${stem}.idx`).pipe(
      Effect.andThen(
        Effect.forEach(
          [".pack", ".rev", ".bitmap", ".mtimes"],
          (extension) => fs.remove(`${stem}${extension}`, { force: true }),
          { discard: true },
        ),
      ),
      // Windows won't remove a pack another git has open: it is kept whole, and the next pass retries.
      Effect.ignore,
    );
  };

  yield* ensureShared(options.directory);

  for (const name of yield* entries(options.directory)) {
    if (!STORE_NAME.test(name)) continue;
    // One store that can't be moved keeps its objects, and the rest still move.
    yield* adopt(path.join(options.directory, name)).pipe(
      Effect.catch((error) => Effect.logWarning(`Kept ${name}'s snapshots where they are: ${error.message}`)),
    );
  }

  const loose = (yield* Effect.forEach(
    (yield* entries(objects)).filter((name) => /^[0-9a-f]{2}$/.test(name)),
    (prefix) =>
      entries(path.join(objects, prefix)).pipe(
        Effect.map((names) =>
          names.filter((name) => /^[0-9a-f]{38}$/.test(name)).map((name) => prefix + name),
        ),
      ),
    { concurrency: 16 },
  )).flat();
  if (loose.length > 0 && loose.length >= (options.looseLimit ?? LOOSE_LIMIT)) {
    yield* pack(loose);
    // Only what a pack holds goes: an object written since stays loose for the next pass.
    yield* onShared(["prune-packed", "--quiet"], "Couldn't tidy the snapshot store.");
  }

  const names = yield* entries(packs);
  const stemOf = (name: string) => name.slice(0, name.indexOf("."));
  const indexed = new Set(names.filter((name) => name.endsWith(".idx")).map(stemOf));
  const kept = new Set(names.filter((name) => name.endsWith(".keep")).map(stemOf));
  const current = names.filter((name) => name.endsWith(".pack") && indexed.has(stemOf(name)));
  // What an earlier pass left: the rest of a pack whose index went but which Windows wouldn't let go
  // of then, and the files of a pack git was stopped writing. Git writes a pack's index last, so only
  // old ones go.
  const now = Date.now();
  for (const name of names) {
    const stem = stemOf(name);
    const orphan =
      name.startsWith("tmp_") || (name.startsWith("pack-") && !indexed.has(stem) && !kept.has(stem));
    if (!orphan) continue;
    const modified = yield* fs.stat(path.join(packs, name)).pipe(
      Effect.map((info) => Option.getOrUndefined(info.mtime)?.getTime() ?? now),
      Effect.orElseSucceed(() => now),
    );
    if (now - modified > ORPHAN_AGE)
      yield* fs.remove(path.join(packs, name), { force: true }).pipe(Effect.ignore);
  }
  const merged = current.filter((name) => !kept.has(name.slice(0, -5)));
  if (merged.length >= Math.max(2, options.packLimit ?? PACK_LIMIT)) {
    // Listed after the packs were, so every object they hold is in the list.
    const into = yield* pack(yield* objectsOf(shared, objects));
    yield* Effect.forEach(
      merged.filter((name) => name !== `${into}.pack`),
      drop,
      { discard: true },
    );
    yield* onShared(["prune-packed", "--quiet"], "Couldn't tidy the snapshot store.");
  }
});

/**
 * Points `store`'s own object directory at the shared one, so git run on the store by hand, or an
 * older Cerium, reads its snapshots too.
 */
const pointAtShared = (fs: FileSystem.FileSystem, path: Path.Path, store: string, shared: string) => {
  const info = path.join(store, "objects", "info");
  return fs.makeDirectory(info, { recursive: true }).pipe(
    Effect.andThen(fs.writeFileString(path.join(info, "alternates"), `${gitPath(shared)}\n`)),
    Effect.mapError(() => new CheckpointError({ message: "Couldn't write the snapshot store's settings." })),
  );
};

/**
 * Snapshots under `directory`: a store per folder, and the object store they share, kept small in the
 * background. Requires `FileSystem`, `Path` and `ChildProcessSpawner`.
 */
export const checkpointsLayer = (options: { readonly directory: string }) =>
  Layer.effect(
    Checkpoints,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const context = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
      >();
      /** Where saves run, apart from whoever waits on them: one that outlasts its waiters still finishes. */
      const layerScope = yield* Scope.Scope;
      const sharedObjects = path.join(options.directory, SHARED, "objects");

      /** Whether the shared store is known to exist; made on first use, as git may be missing. */
      let shared = false;
      const sharedStore = Effect.suspend(() =>
        shared
          ? Effect.void
          : ensureShared(options.directory).pipe(
              Effect.provideContext(context),
              Effect.tap(() =>
                Effect.sync(() => {
                  shared = true;
                }),
              ),
            ),
      );

      /** One maintenance at a time, started a while after the app does and then by saves now and again. */
      let maintaining = false;
      let maintained = Date.now();
      const maintain = Effect.suspend(() => {
        if (maintaining) return Effect.void;
        maintaining = true;
        return maintainCheckpoints({ directory: options.directory }).pipe(
          Effect.provideContext(context),
          Effect.catch((error) => Effect.logWarning(`Snapshot maintenance stopped: ${error.message}`)),
          Effect.ensuring(
            Effect.sync(() => {
              maintaining = false;
              maintained = Date.now();
            }),
          ),
        );
      });
      yield* Effect.sleep(MAINTENANCE_DELAY).pipe(Effect.andThen(maintain), Effect.forkIn(layerScope));
      const maintainNowAndThen = Effect.suspend(() =>
        maintaining || Date.now() - maintained < MAINTENANCE_INTERVAL
          ? Effect.void
          : maintain.pipe(Effect.forkIn(layerScope), Effect.asVoid),
      );
      /**
       * Each store's save in progress, and the one queued behind it. Everyone who asks while one runs
       * shares the next, which starts once it ends: however many threads share a folder, a turn waits
       * on two saves at most.
       */
      const saves = new Map<string, { running?: Pending; next?: Pending }>();
      /**
       * Each saved folder's watcher, by store. A save with nothing changed since the last began serves
       * that one's snapshot without running git: most turns start where the last one left the folder.
       */
      const watched = new Map<string, Watched>();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const entry of watched.values()) entry.close();
          watched.clear();
        }),
      );

      /** `folder`'s watcher, started on its first save; none while the OS can't watch it. */
      const watchedFolder = (store: string, folder: string): Watched | undefined => {
        const existing = watched.get(store);
        if (existing !== undefined) return existing;
        try {
          let close = () => {};
          const entry: Watched = { dirty: true, close: () => close() };
          const watcher = watchFolder(
            folder,
            { recursive: true, persistent: false, ignore: snapshotSkips },
            (event, name) => {
              if (entry.dirty) return;
              // A report without a name may be an overflow: anything could have changed.
              if (name === null) {
                entry.dirty = true;
                return;
              }
              const relative = name.toString();
              if (outsideSnapshots(relative)) return;
              // Windows says a folder changed when git merely reads it; a change inside one names
              // what changed in it too.
              if (
                event === "change" &&
                statSync(path.join(folder, relative), { throwIfNoEntry: false })?.isDirectory() === true
              ) {
                return;
              }
              entry.dirty = true;
            },
          );
          close = () => watcher.close();
          // A watcher that fails can't say what changed any more; the next save starts another.
          watcher.on("error", () => {
            entry.dirty = true;
            entry.close();
            if (watched.get(store) === entry) watched.delete(store);
          });
          watched.set(store, entry);
          return entry;
        } catch {
          return undefined;
        }
      };

      /** Where `folder`'s snapshots are kept: a name from its path, the same however it is spelled. */
      const storeOf = (folder: string) => {
        const resolved = path.resolve(folder);
        const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
        return path.join(options.directory, createHash("sha256").update(key).digest("hex").slice(0, 20));
      };

      /**
       * Runs git on `store` with `folder` as its work tree. It writes objects to the shared store, and
       * reads those an older Cerium kept in the folder's own until maintenance moves them.
       */
      const inFolder = (store: string, folder: string, more: GitOptions): RunOptions => ({
        cwd: folder,
        gitDir: store,
        workTree: folder,
        objects: sharedObjects,
        alternates: path.join(store, "objects"),
        ...more,
      });
      const git = (store: string, folder: string, args: ReadonlyArray<string>, more: GitOptions = {}) =>
        sharedStore.pipe(Effect.andThen(runGit(spawner, args, inFolder(store, folder, more))));

      /**
       * Git's output, failing with `message` when it exits with an error. Output cut at `limit` ends
       * at its last whole line.
       */
      const gitOk = (
        store: string,
        folder: string,
        args: ReadonlyArray<string>,
        message: string,
        more: GitOptions = {},
      ) => sharedStore.pipe(Effect.andThen(runGitOk(spawner, args, message, inFolder(store, folder, more))));

      /** Makes the folder's store the first time it is used. */
      const ensureStore = Effect.fn("Checkpoints.ensureStore")(function* (store: string, folder: string) {
        yield* sharedStore;
        const exists = yield* fs.exists(path.join(store, "HEAD")).pipe(Effect.orElseSucceed(() => false));
        if (exists) return;
        yield* fs
          .makeDirectory(store, { recursive: true })
          .pipe(Effect.mapError(() => new CheckpointError({ message: `Couldn't make ${store}.` })));
        yield* runGitOk(spawner, ["init", "--quiet", "--bare"], "Couldn't make the snapshot store.", {
          cwd: folder,
          gitDir: store,
          objects: path.join(store, "objects"),
        });
        yield* pointAtShared(fs, path, store, sharedObjects);
        yield* fs
          .writeFileString(path.join(store, "info", "exclude"), `${DEFAULT_EXCLUDES.join("\n")}\n`)
          .pipe(
            Effect.mapError(
              () => new CheckpointError({ message: "Couldn't write the snapshot store's excludes." }),
            ),
          );
      });

      /**
       * Runs `use` with a copy of the store's index, removed after, so git never locks the index
       * itself: a git cut short leaves only its copy behind. `keep` puts the copy in the index's place.
       */
      const withScratchIndex = <A>(
        store: string,
        use: (index: string) => Effect.Effect<A, CheckpointError>,
        keep: boolean,
      ) => {
        const index = path.join(store, "index");
        const scratch = path.join(store, `index-${randomUUID()}`);
        return Effect.gen(function* () {
          if (yield* fs.exists(index).pipe(Effect.orElseSucceed(() => false))) {
            yield* fs
              .copyFile(index, scratch)
              .pipe(
                Effect.mapError(() => new CheckpointError({ message: "Couldn't read the snapshot store." })),
              );
          }
          const result = yield* use(scratch);
          if (keep) {
            yield* fs
              .rename(scratch, index)
              .pipe(
                Effect.mapError(
                  () => new CheckpointError({ message: "Couldn't update the snapshot store." }),
                ),
              );
          }
          return result;
        }).pipe(
          Effect.ensuring(
            Effect.all([
              fs.remove(scratch, { force: true }),
              fs.remove(`${scratch}.lock`, { force: true }),
            ]).pipe(Effect.ignore),
          ),
        );
      };

      /** Saves the folder's files as they are now. */
      const run = (store: string, folder: string) =>
        Effect.gen(function* () {
          yield* ensureStore(store, folder);
          return yield* withScratchIndex(
            store,
            (index) =>
              Effect.gen(function* () {
                // A file that can't be read, or a nested repository with nothing committed, is left out
                // rather than failing the snapshot.
                yield* git(store, folder, ["add", "--all", "--ignore-errors", "--", "."], { index });
                const tree = yield* gitOk(
                  store,
                  folder,
                  ["write-tree"],
                  "Couldn't save the folder's files.",
                  {
                    index,
                  },
                );
                return tree.trim();
              }),
            true,
          );
        }).pipe(
          Effect.timeoutOrElse({
            duration: RUN_TIMEOUT,
            orElse: () => Effect.fail(new CheckpointError({ message: "The folder is too big to save." })),
          }),
        );

      /** Runs `pending`'s save apart from its waiters, then the one queued behind it. */
      const launch = (store: string, folder: string, pending: Pending): Effect.Effect<void> =>
        Effect.suspend(() => {
          // What changes from here on may or may not make it into this save, so it counts against it.
          const entry = watchedFolder(store, folder);
          if (entry !== undefined) {
            entry.dirty = false;
            delete entry.tree;
          }
          return run(store, folder).pipe(
            Effect.tap((tree) =>
              Effect.sync(() => {
                if (entry !== undefined) entry.tree = tree;
              }),
            ),
            Effect.tap(() => maintainNowAndThen),
          );
        }).pipe(
          Deferred.into(pending),
          // Whatever became of it, even cut short, the queue moves on.
          Effect.ensuring(
            Effect.suspend(() => {
              const state = saves.get(store) ?? {};
              const next = state.next;
              saves.set(store, next === undefined ? {} : { running: next });
              return next === undefined ? Effect.void : launch(store, folder, next);
            }),
          ),
          Effect.forkIn(layerScope),
          Effect.asVoid,
        );

      const save = Effect.fn("Checkpoints.save")(function* (
        folder: string,
        options: { readonly reuse?: boolean } = {},
      ) {
        const store = storeOf(folder);
        const state = saves.get(store) ?? {};
        saves.set(store, state);
        const entry = watched.get(store);
        if (
          options.reuse === true &&
          entry?.tree !== undefined &&
          !entry.dirty &&
          state.running === undefined &&
          state.next === undefined
        ) {
          return entry.tree;
        }
        // A save queued behind the running one starts after this call, so it holds the files as they
        // are now or later: it serves this caller too.
        let pending = state.next;
        if (pending === undefined) {
          pending = Deferred.makeUnsafe<string, CheckpointError>();
          if (state.running === undefined) {
            state.running = pending;
            yield* launch(store, folder, pending);
          } else state.next = pending;
        }
        // Only the wait gives up: the save goes on, and serves whoever asks next.
        return yield* Deferred.await(pending).pipe(
          Effect.timeoutOrElse({
            duration: WAIT_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new CheckpointError({ message: "The folder took too long to save, so it has no snapshot." }),
              ),
          }),
        );
      });

      const changes = Effect.fn("Checkpoints.changes")(function* (folder: string, from: string, to: string) {
        if (from === to) return [];
        const store = storeOf(folder);
        const output = yield* gitOk(
          store,
          folder,
          ["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to],
          "Couldn't compare the folder's snapshots.",
        );
        return parseNameStatus(output);
      });

      const lines = Effect.fn("Checkpoints.lines")(function* (folder: string, from: string, to: string) {
        if (from === to) return [];
        const output = yield* gitOk(
          storeOf(folder),
          folder,
          ["diff-tree", "-r", "-z", "--no-renames", "--numstat", from, to],
          "Couldn't compare the folder's snapshots.",
        );
        return parseNumstat(output);
      });

      const diff = Effect.fn("Checkpoints.diff")(function* (
        folder: string,
        from: string,
        to: string,
        file: string,
        context: number,
      ) {
        return yield* gitOk(
          storeOf(folder),
          folder,
          [
            "diff-tree",
            "-p",
            "--no-renames",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            `-U${Math.max(0, Math.floor(context))}`,
            from,
            to,
            "--",
            file,
          ],
          "Couldn't compare the file's snapshots.",
          // No more than the viewer is sent of a diff is read, so a huge file's isn't held whole.
          { limit: DIFF_BYTES },
        );
      });

      const restore = Effect.fn("Checkpoints.restore")(function* (
        folder: string,
        snapshot: string,
        paths: ReadonlyArray<string>,
      ) {
        if (paths.length === 0) return;
        const store = storeOf(folder);
        yield* withScratchIndex(
          store,
          (index) =>
            Effect.gen(function* () {
              const held = new Set(
                (yield* gitOk(
                  store,
                  folder,
                  ["ls-tree", "-r", "-z", "--name-only", snapshot],
                  "Couldn't read the snapshot.",
                ))
                  .split("\0")
                  .filter((name) => name !== ""),
              );
              const back = paths.filter((file) => held.has(file));
              const gone = paths.filter((file) => !held.has(file));
              if (back.length > 0) {
                yield* gitOk(
                  store,
                  folder,
                  [
                    "restore",
                    `--source=${snapshot}`,
                    "--staged",
                    "--worktree",
                    "--pathspec-from-file=-",
                    "--pathspec-file-nul",
                  ],
                  "Couldn't put the files back.",
                  { stdin: `${back.join("\0")}\0`, index },
                );
              }
              yield* Effect.forEach(
                gone,
                (file) =>
                  fs
                    .remove(path.join(folder, file), { force: true })
                    .pipe(
                      Effect.mapError(() => new CheckpointError({ message: `Couldn't remove ${file}.` })),
                    ),
                { discard: true },
              );
            }),
          // What the restore staged is dropped with its copy: the next save reads the files afresh.
          false,
        );
      });

      return Checkpoints.of({ save, changes, lines, diff, restore });
    }),
  );
