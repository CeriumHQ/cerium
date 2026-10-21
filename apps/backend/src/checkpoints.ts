import { CheckpointError, Checkpoints, type SnapshotChange, type SnapshotLines } from "@cerium/orchestrator";
import { Deferred, Effect, FileSystem, Layer, Path, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { createHash, randomUUID } from "node:crypto";

// Snapshots of work threads' folders, kept in a bare git repository of Cerium's own per folder: git's
// index makes a snapshot of an unchanged tree cheap, and its object store keeps each version of a file
// once. The folder's own repository, if it has one, is never read or written: its `.gitignore` files
// still apply, since they sit in the folder.

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

/**
 * How long a turn waits for its snapshot before starting without one. A folder's first save reads
 * every file, so it can take longer; it carries on, and the next save is quick.
 */
const WAIT_TIMEOUT = "15 seconds";

/** How long one save may run before it is stopped: a folder too big to save in that time gets none. */
const RUN_TIMEOUT = "5 minutes";

type Pending = Deferred.Deferred<string, CheckpointError>;

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
  readonly code: number;
}

/**
 * Snapshots under `directory`, one store per folder. Requires `FileSystem`, `Path` and
 * `ChildProcessSpawner`.
 */
export const checkpointsLayer = (options: { readonly directory: string }) =>
  Layer.effect(
    Checkpoints,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      /** Where saves run, apart from whoever waits on them: one that outlasts its waiters still finishes. */
      const layerScope = yield* Scope.Scope;
      /**
       * Each store's save in progress, and the one queued behind it. Everyone who asks while one runs
       * shares the next, which starts once it ends: however many threads share a folder, a turn waits
       * on two saves at most.
       */
      const saves = new Map<string, { running?: Pending; next?: Pending }>();

      /** Where `folder`'s snapshots are kept: a name from its path, the same however it is spelled. */
      const storeOf = (folder: string) => {
        const resolved = path.resolve(folder);
        const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
        return path.join(options.directory, createHash("sha256").update(key).digest("hex").slice(0, 20));
      };

      /**
       * Runs git on `store` with `folder` as its work tree; `init` makes the store, so it has neither.
       * `index` is the index file it uses, for commands that read or write one.
       */
      const git = (
        store: string,
        folder: string,
        args: ReadonlyArray<string>,
        options: { readonly stdin?: string; readonly index?: string } = {},
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(
                "git",
                args[0] === "init"
                  ? [...args]
                  : [`--git-dir=${store}`, `--work-tree=${folder}`, ...SETTINGS, ...args],
                {
                  cwd: folder,
                  // Paths are names, never patterns: a file called `*.ts` restores only itself.
                  env: {
                    GIT_TERMINAL_PROMPT: "0",
                    GIT_LITERAL_PATHSPECS: "1",
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
            const [stdout, stderr] = yield* Effect.all(
              [
                Stream.mkString(Stream.decodeText(handle.stdout)),
                Stream.mkString(Stream.decodeText(handle.stderr)),
              ],
              { concurrency: 2 },
            );
            return { stdout, stderr, code: Number(yield* handle.exitCode) } satisfies GitResult;
          }),
        ).pipe(
          Effect.mapError(
            () =>
              new CheckpointError({ message: "Cerium couldn't run git. Is it installed and on the PATH?" }),
          ),
        );

      const gitOk = (
        store: string,
        folder: string,
        args: ReadonlyArray<string>,
        message: string,
        options: { readonly stdin?: string; readonly index?: string } = {},
      ) =>
        git(store, folder, args, options).pipe(
          Effect.flatMap((result) =>
            result.code === 0
              ? Effect.succeed(result.stdout)
              : Effect.logWarning(`git ${args[0]} failed in ${store}: ${result.stderr.trim()}`).pipe(
                  Effect.andThen(Effect.fail(new CheckpointError({ message }))),
                ),
          ),
        );

      /** Makes the folder's store the first time it is used. */
      const ensureStore = Effect.fn("Checkpoints.ensureStore")(function* (store: string, folder: string) {
        const exists = yield* fs.exists(path.join(store, "HEAD")).pipe(Effect.orElseSucceed(() => false));
        if (exists) return;
        yield* fs
          .makeDirectory(store, { recursive: true })
          .pipe(Effect.mapError(() => new CheckpointError({ message: `Couldn't make ${store}.` })));
        yield* gitOk(
          store,
          folder,
          ["init", "--quiet", "--bare", store],
          "Couldn't make the snapshot store.",
        );
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
        run(store, folder).pipe(
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

      const save = Effect.fn("Checkpoints.save")(function* (folder: string) {
        const store = storeOf(folder);
        const state = saves.get(store) ?? {};
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
