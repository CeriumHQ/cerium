import { CheckpointError, type SnapshotChange, type SnapshotLines } from "@cerium/orchestrator";
import { Effect, Fiber, FileSystem, Option, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { randomUUID } from "node:crypto";

// The git underneath the snapshot stores (checkpoints.ts): running git on a folder's store or the
// shared one, reading what it prints, making the shared store and pointing folders' stores at it,
// and the maintenance that keeps them small without dropping a snapshot.

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
export const SHARED = "shared";

/** A folder's own store, named for its path. */
const STORE_NAME = /^[0-9a-f]{20}$/;

/** Loose objects the shared store gathers before maintenance packs them. */
const LOOSE_LIMIT = 1_000;

/** Packs the shared store gathers before maintenance packs them into one. */
const PACK_LIMIT = 16;

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

export interface GitOptions {
  readonly stdin?: string;
  /** The index file git uses, for commands that read or write one. */
  readonly index?: string;
  /** At most this many bytes of stdout are read; unlimited unless given. */
  readonly limit?: number;
}

export interface RunOptions extends GitOptions {
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
export const runGit = (spawner: Spawner, args: ReadonlyArray<string>, options: RunOptions) =>
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
export const runGitOk = (
  spawner: Spawner,
  args: ReadonlyArray<string>,
  message: string,
  options: RunOptions,
) =>
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
export const ensureShared = Effect.fn("Checkpoints.ensureShared")(function* (directory: string) {
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
export const pointAtShared = (fs: FileSystem.FileSystem, path: Path.Path, store: string, shared: string) => {
  const info = path.join(store, "objects", "info");
  return fs.makeDirectory(info, { recursive: true }).pipe(
    Effect.andThen(fs.writeFileString(path.join(info, "alternates"), `${gitPath(shared)}\n`)),
    Effect.mapError(() => new CheckpointError({ message: "Couldn't write the snapshot store's settings." })),
  );
};
