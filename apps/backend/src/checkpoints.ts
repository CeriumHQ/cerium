import { CheckpointError, Checkpoints } from "@cerium/orchestrator";
import { Deferred, Effect, FileSystem, Layer, Option, Path, Scope } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { createHash, randomUUID } from "node:crypto";
import { statSync, watch as watchFolder } from "node:fs";
import { lstat, readdir } from "node:fs/promises";

import {
  ensureShared,
  pointAtShared,
  runGit,
  runGitOk,
  SHARED,
  maintainCheckpoints,
  parseNameStatus,
  parseNumstat,
  type GitOptions,
  type RunOptions,
} from "./checkpointStores.ts";
import { DIFF_BYTES } from "./files.ts";

export { maintainCheckpoints, parseNameStatus, parseNumstat } from "./checkpointStores.ts";

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

/** Recursive watchers are only an optimization: retain the most recently used folders, not every worktree. */
const WATCHED_LIMIT = 32;

type Pending = Deferred.Deferred<string, CheckpointError>;

/** What a folder's watcher has seen since its last save began, and that save's snapshot. */
interface Watched {
  /** Something in the folder changed since the last save began, or the watcher can't say. */
  dirty: boolean;
  /** The last save's snapshot, once it finished. */
  tree?: string;
  readonly close: () => void;
}

/** How long the first maintenance waits after the app starts, so it doesn't slow the start. */
const MAINTENANCE_DELAY = "1 minute";

/** How long after one maintenance a save starts the next. */
const MAINTENANCE_INTERVAL = 10 * 60_000;

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

      const recentWatcher = (store: string) => {
        const entry = watched.get(store);
        if (entry !== undefined) {
          watched.delete(store);
          watched.set(store, entry);
        }
        return entry;
      };

      // Stop watching before restores that can replace a directory with a file (Linux's recursive
      // watcher throws ENOTDIR when a watched directory becomes a file) and drop any cached snapshot.
      const dropWatcher = (store: string) => {
        const entry = watched.get(store);
        if (entry === undefined) return;
        watched.delete(store);
        entry.close();
      };

      /** `folder`'s watcher, started on its first save; none while the OS can't watch it. */
      const watchedFolder = (store: string, folder: string): Watched | undefined => {
        const existing = recentWatcher(store);
        if (existing !== undefined) return existing;
        try {
          let close = () => {};
          const entry: Watched = { dirty: true, close: () => close() };
          const started = Date.now();
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
              // macOS's FSEvents can report, late, what was written just before the watcher started.
              // A file whose status last changed before then hasn't changed since (nothing can set a
              // status-change time back); one that's gone did.
              if (
                process.platform === "darwin" &&
                (statSync(path.join(folder, relative), { throwIfNoEntry: false })?.ctimeMs ?? started) <
                  started
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
          if (watched.size > WATCHED_LIMIT) {
            const [oldest, idle] = watched.entries().next().value!;
            watched.delete(oldest);
            idle.close();
          }
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
            yield* Effect.gen(function* () {
              const { mtime } = yield* fs.stat(index);
              yield* fs.copyFile(index, scratch);
              // Git rechecks files as new as the index. A newer copy can hide a same-size edit.
              if (Option.isSome(mtime)) yield* fs.utimes(scratch, mtime.value, mtime.value);
            }).pipe(
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
              if (next === undefined) {
                saves.delete(store);
                return Effect.void;
              }
              saves.set(store, { running: next });
              return launch(store, folder, next);
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
        const entry = recentWatcher(store);
        if (
          options.reuse === true &&
          entry?.tree !== undefined &&
          !entry.dirty &&
          state.running === undefined &&
          state.next === undefined
        ) {
          return entry.tree;
        }
        saves.set(store, state);
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

      const changes = Effect.fn("Checkpoints.changes")(function* (
        folder: string,
        from: string,
        to: string,
        paths?: ReadonlyArray<string>,
      ) {
        if (from === to || paths?.length === 0) return [];
        const store = storeOf(folder);
        const output = yield* gitOk(
          store,
          folder,
          ["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to, "--", ...(paths ?? [])],
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
        { protectOtherPaths = false }: { readonly protectOtherPaths?: boolean } = {},
      ) {
        if (paths.length === 0) return [];
        const store = storeOf(folder);
        return yield* withScratchIndex(
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
              const gone = paths.filter((file) => !held.has(file));
              const removing = new Set(gone);
              const hasOtherFiles = async (dir: string): Promise<boolean> => {
                for (const entry of await readdir(path.join(folder, dir), { withFileTypes: true })) {
                  const child = `${dir}/${entry.name}`;
                  if (entry.isDirectory() ? await hasOtherFiles(child) : !removing.has(child)) return true;
                }
                return false;
              };
              // Git can replace a directory or a file in an ancestor while restoring one path.
              const blocked = async (file: string): Promise<boolean> => {
                const parts = file.split("/");
                for (let length = 1; length <= parts.length; length++) {
                  const part = parts.slice(0, length).join("/");
                  const stat = await lstat(path.join(folder, part)).catch((error: unknown) => {
                    if (
                      typeof error === "object" &&
                      error !== null &&
                      "code" in error &&
                      error.code === "ENOENT"
                    ) {
                      return undefined;
                    }
                    throw error;
                  });
                  if (stat === undefined) return false;
                  if (part === file) return stat.isDirectory() && hasOtherFiles(file);
                  if (!stat.isDirectory()) return !removing.has(part);
                }
                return false;
              };
              const back = paths.filter((file) => held.has(file));
              const kept = protectOtherPaths
                ? yield* Effect.filter(back, (file) =>
                    Effect.tryPromise({
                      try: () => blocked(file),
                      catch: () => new CheckpointError({ message: `Couldn't check paths around ${file}.` }),
                    }),
                  )
                : [];
              const writing = back.filter((file) => !kept.includes(file));
              const related = (file: string) =>
                protectOtherPaths &&
                writing.some((target) => file.startsWith(`${target}/`) || target.startsWith(`${file}/`));
              const remove = (files: ReadonlyArray<string>) =>
                Effect.forEach(
                  files,
                  (file) =>
                    fs
                      .remove(path.join(folder, file), { force: true })
                      .pipe(
                        Effect.mapError(() => new CheckpointError({ message: `Couldn't remove ${file}.` })),
                      ),
                  { discard: true },
                );
              if (writing.length > 0 || gone.length > 0) dropWatcher(store);
              yield* remove(gone.filter(related));
              if (writing.length > 0) {
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
                  { stdin: `${writing.join("\0")}\0`, index },
                );
              }
              yield* remove(gone.filter((file) => !related(file)));
              return kept;
            }),
          // What the restore staged is dropped with its copy: the next save reads the files afresh.
          false,
        );
      });

      const restoreInto = Effect.fn("Checkpoints.restoreInto")(function* (
        source: string,
        snapshot: string,
        destination: string,
      ) {
        const sourceStore = storeOf(source);
        const destinationStore = storeOf(destination);
        yield* save(destination);
        dropWatcher(destinationStore);
        // Seed the temporary index with the new checkout so git removes files absent from the
        // snapshot and handles file/directory replacements, without staging changes in the worktree.
        yield* withScratchIndex(
          destinationStore,
          (index) =>
            gitOk(
              sourceStore,
              destination,
              ["read-tree", "--reset", "-u", snapshot],
              "Couldn't restore the turn's snapshot into the worktree.",
              { index },
            ),
          false,
        );
      });

      return Checkpoints.of({ save, changes, lines, diff, restore, restoreInto });
    }),
  );
