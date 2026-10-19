import type {
  DiffHunk,
  DiffLine,
  FileChange,
  FileDiff,
  FileEntry,
  FileListing,
  FilePreview,
  FileState,
  FileStatuses,
  FilesChanged,
} from "@cerium/rpc";
import { Cache, Cause, Context, Effect, FileSystem, Layer, Path, Queue, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { watch as watchFolder } from "node:fs";
import { readdir } from "node:fs/promises";
import { posix, win32 } from "node:path";

import { imageType, SKIPPED, Workspace } from "./workspace.ts";

// What the file explorer needs from a work thread's folder: its entries a level at a time, what git
// says about them, a file to preview, a changed file's diff, and word of what changes while it's open.
// Every path a request names is relative to the folder it asks about, and never leaves it.

/** A request about a thread's folder the backend refused; `message` is written for the user. */
export class FilesError extends Schema.TaggedError<FilesError>()("FilesError", {
  message: Schema.String,
}) {}

/** Entries a folder lists at once; a folder with more is cut short and says so. */
const MAX_ENTRIES = 5_000;
/** The part of a file the preview reads; a longer one is shown up to here. */
export const PREVIEW_BYTES = 256 * 1024;
/** What a diff may take of git's output. */
const DIFF_BYTES = 1024 * 1024;
/** Lines of a diff that are sent. */
const MAX_DIFF_LINES = 4_000;
/** Changed files that are listed. */
const MAX_CHANGES = 5_000;
/** Changed paths one batch lists, beyond which it says to read everything again. */
const MAX_BATCH = 300;
/** How long changes are gathered into one batch. */
const BATCH_WINDOW = "300 millis";
/** What a file can be as an image; larger ones aren't previewed, as `ReadImage` refuses them. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/** Version control's own folders: nobody browses them, so listings leave them out. */
const VCS_FOLDERS = new Set([".git", ".hg", ".svn"]);

// ---------------------------------------------------------------------------------------------
// Paths

type PathApi = typeof posix;

const pathApi: PathApi = process.platform === "win32" ? win32 : posix;

/** What Windows treats as a device whatever its extension (`CON`, `nul.txt`, `COM1`). */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?:\..*)?$/i;

/** A character no file's name can hold on Windows, besides the separators. */
// The control characters are the point of the pattern.
// oxlint-disable-next-line no-control-regex
const FORBIDDEN_ON_WINDOWS = /[<>:"|?*\u0000-\u001f]/;

/** The parts of `relative`, or undefined when it names something `root` couldn't hold. */
export const pathSegments = (relative: string, api: PathApi = pathApi): ReadonlyArray<string> | undefined => {
  if (relative.includes("\0")) return undefined;
  const windows = api === win32;
  // A path from the UI is rooted at its folder; one that begins at a drive or a share isn't.
  if (/^[\\/]/.test(relative) && windows) return undefined;
  if (relative.startsWith("/") || (windows && /^[a-z]:/i.test(relative))) return undefined;
  const parts = relative.split(windows ? /[\\/]/ : "/");
  const segments: Array<string> = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") return undefined;
    if (windows) {
      // Windows trims a name's trailing dots and spaces, so `.. ` would climb out like `..`.
      if (FORBIDDEN_ON_WINDOWS.test(part) || /[. ]$/.test(part) || DEVICE_NAME.test(part)) return undefined;
    }
    segments.push(part);
  }
  return segments;
};

/**
 * Where `relative` is under `root`, or undefined when it climbs out, is rooted elsewhere, or isn't a
 * name Windows would keep as written. Windows ignores case and takes either slash.
 */
export const resolveInside = (root: string, relative: string, api: PathApi = pathApi): string | undefined => {
  const segments = pathSegments(relative, api);
  if (segments === undefined) return undefined;
  const base = api.resolve(root);
  const resolved = api.join(base, ...segments);
  return isInside(base, resolved, api) ? resolved : undefined;
};

/** Whether `child` is `folder` or lies under it. */
export const isInside = (folder: string, child: string, api: PathApi = pathApi): boolean => {
  const relative = api.relative(folder, child);
  return relative === "" || (!relative.startsWith("..") && !api.isAbsolute(relative));
};

const joinPath = (folder: string, name: string) => (folder === "" ? name : `${folder}/${name}`);

// ---------------------------------------------------------------------------------------------
// Entries

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folders before files, each group by name, as file managers list them. */
export const compareEntries = (a: FileEntry, b: FileEntry): number =>
  Number(b.folder) - Number(a.folder) ||
  collator.compare(a.name, b.name) ||
  (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

// ---------------------------------------------------------------------------------------------
// Git's output

/** What `git status` says of a path, as the explorer names it. */
export const stateOf = (x: string, y: string): FileState => {
  if (x === "?" && y === "?") return "untracked";
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "conflicted";
  if (x === "D" || y === "D") return "deleted";
  if (x === "R" || y === "R") return "renamed";
  if (x === "A" || x === "C") return "added";
  return "modified";
};

/**
 * The changes `git status --porcelain=v1 -z` lists. Its paths are relative to the repository's top;
 * `prefix` is where the folder asked about sits in it (`apps/ui/`, empty at the top), and paths
 * outside that are left out.
 */
export const parseStatus = (output: string, prefix: string): ReadonlyArray<FileChange> => {
  const fields = output.split("\0");
  const changes: Array<FileChange> = [];
  const within = (path: string) => (path.startsWith(prefix) ? path.slice(prefix.length) : undefined);
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    if (field.length < 4) continue;
    const x = field[0]!;
    const y = field[1]!;
    const path = within(field.slice(3));
    // A rename or copy lists where it came from in the next field.
    const origin = x === "R" || x === "C" || y === "R" || y === "C" ? fields[++index] : undefined;
    if ((x === "!" && y === "!") || path === undefined || path === "") continue;
    const state = stateOf(x, y);
    const from = origin === undefined ? undefined : within(origin);
    changes.push({ path, state, ...(from === undefined || from === "" ? {} : { from }) });
  }
  return changes;
};

/** The hunks of a unified diff, and whether git said the file isn't text. */
export const parseDiff = (
  output: string,
): { readonly hunks: ReadonlyArray<DiffHunk>; readonly binary: boolean } => {
  const hunks: Array<{ oldStart: number; newStart: number; lines: Array<DiffLine> }> = [];
  let binary = false;
  let current: (typeof hunks)[number] | undefined;
  for (const line of output.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
      hunks.push(current);
      continue;
    }
    if (current === undefined) {
      if (/^Binary files .* differ$|^GIT binary patch$/.test(line)) binary = true;
      continue;
    }
    // The next file's header ends this hunk's lines.
    if (line.startsWith("diff --git ")) {
      current = undefined;
      continue;
    }
    const text = line.slice(1).replace(/\r$/, "");
    if (line.startsWith("+")) current.lines.push({ kind: "added", text });
    else if (line.startsWith("-")) current.lines.push({ kind: "removed", text });
    else if (line.startsWith(" ")) current.lines.push({ kind: "context", text });
    // "\ No newline at end of file", and the empty last element of the split.
  }
  return { hunks, binary };
};

/** A whole file as one hunk of added lines, for a file git has nothing to compare with. */
export const additions = (text: string): ReadonlyArray<DiffHunk> => {
  if (text === "") return [];
  const lines = text.replace(/\n$/, "").split("\n");
  return [
    {
      oldStart: 0,
      newStart: 1,
      lines: lines.map((line) => ({ kind: "added", text: line.replace(/\r$/, "") })),
    },
  ];
};

/** At most `limit` lines of `hunks`, cutting the last hunk short. */
export const limitHunks = (
  hunks: ReadonlyArray<DiffHunk>,
  limit: number,
): { readonly hunks: ReadonlyArray<DiffHunk>; readonly truncated: boolean } => {
  const kept: Array<DiffHunk> = [];
  let left = limit;
  for (const hunk of hunks) {
    if (left <= 0) return { hunks: kept, truncated: true };
    if (hunk.lines.length <= left) {
      kept.push(hunk);
      left -= hunk.lines.length;
    } else {
      kept.push({ ...hunk, lines: hunk.lines.slice(0, left) });
      return { hunks: kept, truncated: true };
    }
  }
  return { hunks: kept, truncated: false };
};

// ---------------------------------------------------------------------------------------------
// Reading files

/** Bytes that say a file is not text when they're a tenth of its start, besides tab, newline and the like. */
const isControl = (byte: number) =>
  byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12 && byte !== 27 && byte !== 8;

/** Drops a character the preview's cut left half-read at the end of `bytes`. */
export const withoutPartialCharacter = (bytes: Uint8Array): Uint8Array => {
  for (let back = 1; back <= 3 && back <= bytes.length; back++) {
    const byte = bytes[bytes.length - back]!;
    if ((byte & 0b1100_0000) === 0b1000_0000) continue;
    // A lead byte: whole when the bytes after it are as many as it announces.
    const needs = byte >= 0b1111_0000 ? 4 : byte >= 0b1110_0000 ? 3 : byte >= 0b1100_0000 ? 2 : 1;
    return back >= needs ? bytes : bytes.subarray(0, bytes.length - back);
  }
  return bytes;
};

/**
 * A file's text for the preview, or undefined when it isn't text: it holds NUL bytes, or is mostly
 * control characters. UTF-8 (with or without its BOM) and BOM'd UTF-16 read as written; text that
 * isn't valid UTF-8 reads as Windows-1252, as legacy files are.
 */
export const decodeText = (bytes: Uint8Array, truncated: boolean): string | undefined => {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(
      truncated ? bytes.subarray(0, bytes.length - (bytes.length % 2)) : bytes,
    );
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(
      truncated ? bytes.subarray(0, bytes.length - (bytes.length % 2)) : bytes,
    );
  }
  const head = bytes.subarray(0, 8_000);
  let controls = 0;
  for (const byte of head) {
    if (byte === 0) return undefined;
    if (isControl(byte)) controls++;
  }
  if (head.length > 0 && controls / head.length > 0.1) return undefined;
  const whole = truncated ? withoutPartialCharacter(bytes) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(whole);
  } catch {
    return new TextDecoder("windows-1252").decode(whole);
  }
};

// ---------------------------------------------------------------------------------------------
// Watching

/** What a change the OS reported amounts to: a path under the folder, or git's own state. */
export type Change = { readonly path: string } | { readonly git: true };

/**
 * What a change at `relative` (a path under the watched folder, as the OS reports it) means to the
 * explorer: a path whose entry or contents changed, or word that git's own state did. None for what
 * the explorer never shows: the insides of dependency and cache folders, and git's bookkeeping.
 */
export const watchedChange = (relative: string): Change | undefined => {
  const segments = relative
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part !== "");
  if (segments.length === 0) return undefined;
  if (VCS_FOLDERS.has(segments[0]!)) {
    if (segments[0] !== ".git") return undefined;
    // The index and HEAD move with every add, commit and checkout.
    const second = segments[1];
    return second === "index" || second === "HEAD" || second === "refs" ? { git: true } : undefined;
  }
  // The folder itself changes its parent's listing; what happens inside doesn't matter.
  if (segments.slice(0, -1).some((part) => SKIPPED.has(part))) return undefined;
  return { path: segments.join("/") };
};

// ---------------------------------------------------------------------------------------------

/** Where a folder sits in a git repository: `prefix` is its path from the repository's top, with a trailing slash. */
interface Repository {
  readonly prefix: string;
}

export class Files extends Context.Service<
  Files,
  {
    /** One level of a folder under `root`, git's ignored entries marked. */
    list(root: string, dir: string): Effect.Effect<FileListing, FilesError>;
    /** The files under `root` that differ from the last commit. */
    statuses(root: string): Effect.Effect<FileStatuses, FilesError>;
    /** A file under `root` as the preview shows it. */
    read(root: string, path: string): Effect.Effect<FilePreview, FilesError>;
    /** A changed file against the last commit; `from` is where it was before a rename. */
    diff(root: string, path: string, from?: string): Effect.Effect<FileDiff, FilesError>;
    /** What changes under `root`, in batches, until the stream is dropped. */
    watch(root: string): Stream.Stream<FilesChanged, FilesError>;
  }
>()("cerium/backend/Files") {
  /** Requires `FileSystem`, `Path`, `ChildProcessSpawner` and `Workspace`. */
  static readonly layer = Layer.effect(
    Files,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const workspace = yield* Workspace;

      const refuse = (message: string) => () => new FilesError({ message });

      /**
       * Runs git in `cwd`, and returns what it printed to stdout, as text. Looking takes none of the
       * locks git would take to tidy its index, so it doesn't set off the watcher, and every path is
       * taken as written, never as pathspec magic (unless `magic`). `limit` bytes at most are read;
       * past it the output is cut and `truncated` says so.
       */
      const git = Effect.fn("Files.git")(function* (
        cwd: string,
        args: ReadonlyArray<string>,
        options: { readonly stdin?: string; readonly limit?: number; readonly magic?: boolean } = {},
      ) {
        const limit = options.limit ?? 16 * 1024 * 1024;
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make("git", ["--no-optional-locks", ...args], {
                cwd,
                env: {
                  GIT_OPTIONAL_LOCKS: "0",
                  GIT_TERMINAL_PROMPT: "0",
                  // `check-ignore` takes names, not pathspecs, and refuses the setting.
                  ...(options.magic === true ? {} : { GIT_LITERAL_PATHSPECS: "1" }),
                },
                extendEnv: true,
                stdin:
                  options.stdin === undefined
                    ? "ignore"
                    : Stream.succeed(new TextEncoder().encode(options.stdin)),
                stderr: "ignore",
              }),
            );
            let size = 0;
            const chunks = yield* handle.stdout.pipe(
              Stream.takeUntil((chunk) => (size += chunk.length) >= limit),
              Stream.runCollect,
            );
            const truncated = size >= limit;
            // A cut-off git is still writing: leaving the scope stops it, and its exit tells nothing.
            const code = truncated ? -1 : Number(yield* handle.exitCode);
            return { stdout: Buffer.concat(chunks).toString("utf8"), code, truncated };
          }),
        );
      });

      /** Where `root` sits in a git repository, or undefined when it isn't in one (or git isn't there). */
      const repositories = yield* Cache.make({
        capacity: 16,
        timeToLive: "30 seconds",
        lookup: (root: string) =>
          git(root, ["rev-parse", "--is-inside-work-tree", "--show-prefix"]).pipe(
            Effect.map(({ stdout, code }): Repository | undefined => {
              if (code !== 0) return undefined;
              const [inside, prefix = ""] = stdout.split("\n");
              return inside?.trim() === "true" ? { prefix: prefix.trim() } : undefined;
            }),
            Effect.orElseSucceed(() => undefined),
          ),
      });

      /** `root`'s real location, when it is a folder. */
      const folderOf = Effect.fn("Files.folderOf")(function* (root: string) {
        const base = path.resolve(root);
        const info = yield* fs.stat(base).pipe(Effect.mapError(refuse("That folder is gone.")));
        if (info.type !== "Directory") return yield* new FilesError({ message: "That isn't a folder." });
        return base;
      });

      /**
       * `relative` under `root` on disk, refused when it climbs out of `root`, or a link in it leads
       * somewhere else. A path that isn't there yet is allowed: it can't lead anywhere.
       */
      const locate = Effect.fn("Files.locate")(function* (root: string, relative: string) {
        const base = yield* folderOf(root);
        const target = resolveInside(base, relative);
        if (target === undefined)
          return yield* new FilesError({ message: "That path isn't inside the thread's folder." });
        const real = yield* Effect.option(fs.realPath(target));
        if (real._tag === "Some") {
          const realBase = yield* fs.realPath(base).pipe(Effect.orElseSucceed(() => base));
          if (!isInside(realBase, real.value))
            return yield* new FilesError({ message: "That link leads out of the thread's folder." });
        }
        return { base, target };
      });

      /** Which of `names` (paths under `cwd`) git ignores. */
      const ignoredAmong = Effect.fn("Files.ignoredAmong")(function* (
        cwd: string,
        names: ReadonlyArray<string>,
      ) {
        if (names.length === 0) return new Set<string>();
        // Exit status 1 only says that none are ignored.
        const { stdout } = yield* git(cwd, ["check-ignore", "-z", "--stdin"], {
          stdin: `${names.join("\0")}\0`,
          magic: true,
        }).pipe(Effect.orElseSucceed(() => ({ stdout: "", code: 1, truncated: false })));
        return new Set(stdout.split("\0").filter((name) => name !== ""));
      });

      const list = Effect.fn("Files.list")(function* (root: string, dir: string) {
        const { base, target } = yield* locate(root, dir);
        const info = yield* fs.stat(target).pipe(Effect.mapError(refuse("That folder is gone.")));
        if (info.type !== "Directory") return yield* new FilesError({ message: "That isn't a folder." });
        const dirents = yield* Effect.tryPromise({
          try: () => readdir(target, { withFileTypes: true }),
          catch: () => new FilesError({ message: "That folder couldn't be read." }),
        });
        const entries = yield* Effect.forEach(
          dirents.filter((dirent) => !(dirent.isDirectory() && VCS_FOLDERS.has(dirent.name))),
          (dirent) =>
            Effect.gen(function* () {
              const link = dirent.isSymbolicLink();
              // A link's kind is its target's; one that leads nowhere is listed as a file.
              const folder = link
                ? yield* fs.stat(path.join(target, dirent.name)).pipe(
                    Effect.map((linked) => linked.type === "Directory"),
                    Effect.orElseSucceed(() => false),
                  )
                : dirent.isDirectory();
              return {
                name: dirent.name,
                folder,
                ...(link ? { link: true as const } : {}),
                ...(folder && SKIPPED.has(dirent.name) ? { heavy: true as const } : {}),
              } satisfies FileEntry;
            }),
          { concurrency: 16 },
        );
        const sorted = entries.toSorted(compareEntries);
        const shown = sorted.slice(0, MAX_ENTRIES);
        const repository = yield* Cache.get(repositories, base);
        const below = path.relative(base, target).replaceAll("\\", "/");
        const ignored =
          repository === undefined
            ? new Set<string>()
            : yield* ignoredAmong(
                base,
                shown.map((entry) => joinPath(below, entry.name)),
              );
        return {
          entries: shown.map((entry) =>
            ignored.has(joinPath(below, entry.name)) ? { ...entry, ignored: true as const } : entry,
          ),
          ...(sorted.length > MAX_ENTRIES ? { truncated: true as const } : {}),
        } satisfies FileListing;
      });

      const statuses = Effect.fn("Files.statuses")(function* (root: string) {
        const base = yield* folderOf(root);
        const repository = yield* Cache.get(repositories, base);
        if (repository === undefined) return { repository: false, changes: [] } satisfies FileStatuses;
        const { stdout } = yield* git(base, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=normal",
          "--",
          ".",
        ]).pipe(Effect.mapError(refuse("Git couldn't say what changed.")));
        const changes = parseStatus(stdout, repository.prefix);
        return {
          repository: true,
          changes: changes.slice(0, MAX_CHANGES),
          ...(changes.length > MAX_CHANGES ? { truncated: true as const } : {}),
        } satisfies FileStatuses;
      });

      const read = Effect.fn("Files.read")(function* (root: string, relative: string) {
        const { target } = yield* locate(root, relative);
        const info = yield* Effect.option(fs.stat(target));
        if (info._tag === "None") return { _tag: "Missing" } satisfies FilePreview;
        if (info.value.type !== "File") return yield* new FilesError({ message: "That isn't a file." });
        const size = Number(info.value.size);
        if (imageType(target) !== undefined) {
          if (size > MAX_IMAGE_BYTES) return { _tag: "Binary", size } satisfies FilePreview;
          const image = yield* workspace
            .readImage(target)
            .pipe(Effect.mapError((error) => new FilesError({ message: error.message })));
          return { _tag: "Image", image, size } satisfies FilePreview;
        }
        const chunks = yield* fs
          .stream(target, { bytesToRead: PREVIEW_BYTES })
          .pipe(Stream.runCollect, Effect.mapError(refuse("That file couldn't be read.")));
        const bytes = Buffer.concat(chunks);
        const truncated = size > bytes.length;
        const text = decodeText(bytes, truncated);
        return text === undefined
          ? ({ _tag: "Binary", size } satisfies FilePreview)
          : ({ _tag: "Text", text, size, truncated } satisfies FilePreview);
      });

      const diff = Effect.fn("Files.diff")(function* (root: string, relative: string, from?: string) {
        const { base, target } = yield* locate(root, relative);
        const origin = from === undefined ? undefined : resolveInside(base, from);
        if (from !== undefined && origin === undefined)
          return yield* new FilesError({ message: "That path isn't inside the thread's folder." });
        const repository = yield* Cache.get(repositories, base);
        if (repository === undefined)
          return yield* new FilesError({ message: "Git isn't tracking this folder." });
        const paths = [relative, ...(from === undefined ? [] : [from])];
        const parse = (stdout: string, truncated: boolean): FileDiff => {
          const { hunks, binary } = parseDiff(stdout);
          const limited = limitHunks(hunks, MAX_DIFF_LINES);
          return {
            hunks: limited.hunks,
            ...(binary ? { binary: true as const } : {}),
            ...(truncated || limited.truncated ? { truncated: true as const } : {}),
          };
        };
        const failed = refuse("Git couldn't compare that file.");
        const tracked = yield* git(
          base,
          ["diff", "HEAD", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "-U3", "--", ...paths],
          { limit: DIFF_BYTES },
        ).pipe(Effect.mapError(failed));
        const result = parse(tracked.stdout, tracked.truncated);
        const compared = tracked.code === 0 || tracked.truncated;
        if (compared && (result.hunks.length > 0 || result.binary === true)) return result;
        // Nothing to show: the file is unchanged, or git has nothing to compare it with, because it
        // hasn't seen the file or the repository has no commit. Then its whole text is new.
        const exists = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false));
        if (!exists) return result;
        if (compared) {
          const untracked = yield* git(base, [
            "ls-files",
            "-z",
            "--others",
            "--exclude-standard",
            "--",
            relative,
          ]).pipe(Effect.mapError(failed));
          if (untracked.stdout === "") return result;
        }
        const added = yield* git(
          base,
          [
            "diff",
            "--no-index",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "-U3",
            "--",
            "/dev/null",
            relative,
          ],
          { limit: DIFF_BYTES },
        ).pipe(Effect.mapError(failed));
        return parse(added.stdout, added.truncated);
      });

      const watch = (root: string) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const base = yield* folderOf(root);
            const repository = yield* Cache.get(repositories, base);
            const changes = Stream.callback<Change, FilesError>(
              (queue) =>
                Effect.acquireRelease(
                  Effect.try({
                    try: () => {
                      const watcher = watchFolder(base, { recursive: true }, (_event, name) => {
                        if (name === null) return;
                        // Floods inside dependency folders are dropped before they queue.
                        const change = watchedChange(name.toString());
                        if (change !== undefined) Queue.offerUnsafe(queue, change);
                      });
                      watcher.on("error", () =>
                        Queue.failCauseUnsafe(
                          queue,
                          Cause.fail(new FilesError({ message: "That folder can't be watched any more." })),
                        ),
                      );
                      return watcher;
                    },
                    catch: () => new FilesError({ message: "That folder can't be watched." }),
                  }),
                  (watcher) => Effect.sync(() => watcher.close()),
                ),
              { bufferSize: 4_096, strategy: "sliding" },
            );
            return changes.pipe(
              Stream.groupedWithin(2_000, BATCH_WINDOW),
              Stream.mapEffect((batch) =>
                Effect.gen(function* () {
                  const paths = [
                    ...new Set(batch.flatMap((change) => ("path" in change ? [change.path] : []))),
                  ];
                  const touchedGit = batch.some((change) => "git" in change);
                  if (paths.length > MAX_BATCH)
                    return { paths: [], status: true, overflow: true } satisfies FilesChanged;
                  // What git ignores never changes what it says; the explorer still lists it.
                  const ignored =
                    repository === undefined || paths.length === 0
                      ? new Set<string>()
                      : yield* ignoredAmong(base, paths);
                  const status =
                    repository !== undefined && (touchedGit || paths.some((path) => !ignored.has(path)));
                  return { paths, status } satisfies FilesChanged;
                }),
              ),
              Stream.filter((batch) => batch.paths.length > 0 || batch.status || batch.overflow === true),
            );
          }),
        );

      return Files.of({ list, statuses, read, diff, watch });
    }),
  );
}
