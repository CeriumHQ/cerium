import type { Attachment, ImageData, WorkspaceEntry } from "@cerium/protocol";
import { Cache, Context, Crypto, Effect, FileSystem, Layer, Path, Result, Schema } from "effect";
import { Base64 } from "effect/encoding";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { sweepAttachments } from "./attachments.ts";

// What the message box needs from the user's disk: the files it offers after `@`, a place for pasted
// files that have no path of their own, and the images it shows.

/** A request about the user's files the backend refused; `message` is written for the user. */
export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  message: Schema.String,
}) {}

/** Larger files are refused: they would crowd the socket and no harness takes images this big. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** A folder without git is walked, up to this many entries. */
const MAX_WALKED = 20_000;
/** Folders a walk never enters: dependencies, build output, caches. The file explorer opens them only on request. */
export const SKIPPED = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".next",
  ".turbo",
  ".cache",
]);

const imageTypes: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

/** The media type of an image file, by extension; undefined when it isn't one. */
export const imageType = (path: string): string | undefined =>
  imageTypes[path.split(".").at(-1)?.toLowerCase() ?? ""];

/** Characters Windows refuses in a file name, beside control characters. */
const RESERVED = '<>:"/\\|?*';

/** A name that is safe as one path segment on every platform. */
export const safeFileName = (name: string): string => {
  const cleaned = name
    .split("")
    .map((char) => (char.charCodeAt(0) < 32 || RESERVED.includes(char) ? "_" : char))
    .join("")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 120);
  return cleaned === "" ? "attachment" : cleaned;
};

/** Every folder above each file, so folders can be tagged too. */
export const withFolders = (files: ReadonlyArray<string>): ReadonlyArray<WorkspaceEntry> => {
  const folders = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let depth = 1; depth < parts.length; depth++) folders.add(parts.slice(0, depth).join("/"));
  }
  return [
    ...[...folders].map((path) => ({ path, folder: true })),
    ...files.map((path) => ({ path, folder: false })),
  ];
};

const depth = (path: string) => path.split("/").length;
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * A folder's entries as the search reads them: each one's path in lower case, its name and its
 * depth, worked out once for the listing rather than on every keystroke.
 */
export interface SearchableEntries {
  readonly entries: ReadonlyArray<WorkspaceEntry>;
  readonly paths: ReadonlyArray<string>;
  readonly names: ReadonlyArray<string>;
  readonly depths: ReadonlyArray<number>;
}

export const searchable = (entries: ReadonlyArray<WorkspaceEntry>): SearchableEntries => {
  const paths = entries.map((entry) => entry.path.toLowerCase());
  return {
    entries,
    paths,
    names: paths.map(baseName),
    depths: entries.map((entry) => depth(entry.path)),
  };
};

/**
 * How well an entry matches `query` (lower is better), or undefined when it doesn't, by its path
 * and name in lower case.
 */
const score = (path: string, name: string, query: string): number | undefined => {
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (path.includes(query)) return 3;
  // Every character in order, so `trts` finds `transcript/Transcript.tsx`.
  let at = 0;
  for (const char of query) {
    at = path.indexOf(char, at);
    if (at === -1) return undefined;
    at++;
  }
  return 4;
};

/**
 * The entries best matching `query`: names before paths, then shallower and shorter paths. With no
 * query, the folder's top level, folders first.
 */
export const rankEntries = (
  listing: SearchableEntries,
  query: string,
  limit: number,
): ReadonlyArray<WorkspaceEntry> => {
  const { entries, paths, names, depths } = listing;
  const wanted = query.trim().toLowerCase().replaceAll("\\", "/");
  if (wanted === "") {
    return entries
      .filter((_, index) => depths[index] === 1)
      .toSorted((a, b) => Number(b.folder) - Number(a.folder) || a.path.localeCompare(b.path))
      .slice(0, limit);
  }
  if (limit < 1) return [];
  type Match = { readonly index: number; readonly rank: number };
  // Matches that tie keep the listing's order.
  const compare = (a: Match, b: Match) =>
    a.rank - b.rank ||
    depths[a.index]! - depths[b.index]! ||
    entries[a.index]!.path.length - entries[b.index]!.path.length ||
    entries[a.index]!.path.localeCompare(entries[b.index]!.path) ||
    a.index - b.index;
  // The best matches so far, best first. Most of a long listing loses to the worst of them and is
  // turned away at once, rather than sorted with every other match only to be cut.
  const best: Array<Match> = [];
  for (let index = 0; index < entries.length; index++) {
    const rank = score(paths[index]!, names[index]!, wanted);
    if (rank === undefined) continue;
    const match = { index, rank };
    if (best.length === limit && compare(match, best[limit - 1]!) > 0) continue;
    let low = 0;
    let high = best.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compare(best[middle]!, match) < 0) low = middle + 1;
      else high = middle;
    }
    best.splice(low, 0, match);
    if (best.length > limit) best.pop();
  }
  return best.map((match) => entries[match.index]!);
};

export class Workspace extends Context.Service<
  Workspace,
  {
    /** Files and folders in `cwd` matching `query`, best first. */
    search(
      cwd: string,
      query: string,
      limit: number,
    ): Effect.Effect<ReadonlyArray<WorkspaceEntry>, WorkspaceError>;
    /** Keeps a pasted file that has no path of its own, so agents can open it. */
    saveAttachment(name: string, mediaType: string, data: string): Effect.Effect<Attachment, WorkspaceError>;
    /** An image file's bytes, for the UI to show. */
    readImage(path: string): Effect.Effect<ImageData, WorkspaceError>;
  }
>()("cerium/backend/Workspace") {
  /** Requires `FileSystem`, `Path`, `Crypto`, `ChildProcessSpawner` and `Store`. */
  static readonly layer = (options: { readonly attachmentsDirectory: string }) =>
    Layer.effect(
      Workspace,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

        // Pasted files that were never sent are cleared once per launch, without holding startup up.
        yield* sweepAttachments(options.attachmentsDirectory).pipe(
          Effect.ignore({ log: "Warn", message: "Couldn't clear unsent attachments" }),
          Effect.forkScoped,
        );

        /** What git tracks or would track: its own ignore rules decide. Fails outside a repository. */
        const gitFiles = Effect.fn("Workspace.gitFiles")(function* (cwd: string) {
          // A failing git prints nothing to stdout, so whether this is a repository is asked first.
          const inside = yield* spawner.string(
            ChildProcess.make("git", ["rev-parse", "--is-inside-work-tree"], { cwd }),
          );
          if (inside.trim() !== "true")
            return yield* new WorkspaceError({ message: `${cwd} isn't a git repository.` });
          const output = yield* spawner.string(
            ChildProcess.make("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
              cwd,
            }),
          );
          return output.split("\0").filter((file) => file !== "");
        });

        /** A folder outside git, breadth first so a cap still covers its top levels. */
        const walk = Effect.fn("Workspace.walk")(function* (cwd: string) {
          const entries: Array<WorkspaceEntry> = [];
          const queue = [""];
          while (queue.length > 0 && entries.length < MAX_WALKED) {
            const folder = queue.shift()!;
            const names = yield* fs
              .readDirectory(path.join(cwd, folder))
              .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
            for (const name of names.toSorted((a, b) => a.localeCompare(b))) {
              const relative = folder === "" ? name : `${folder}/${name}`;
              const info = yield* Effect.option(fs.stat(path.join(cwd, relative)));
              if (info._tag === "None") continue;
              const isFolder = info.value.type === "Directory";
              if (isFolder && SKIPPED.has(name)) continue;
              entries.push({ path: relative, folder: isFolder });
              if (isFolder) queue.push(relative);
            }
          }
          return entries;
        });

        // Listing a folder is the slow part; typing narrows the same list, so it is kept briefly.
        const listings = yield* Cache.make({
          capacity: 16,
          timeToLive: "20 seconds",
          lookup: (cwd: string) =>
            gitFiles(cwd).pipe(
              Effect.map(withFolders),
              Effect.catch(() => walk(cwd)),
              Effect.map(searchable),
            ),
        });

        const refuse = (message: string) => () => new WorkspaceError({ message });

        return Workspace.of({
          search: (cwd, query, limit) =>
            Effect.gen(function* () {
              const info = yield* fs.stat(cwd).pipe(Effect.mapError(refuse(`${cwd} doesn't exist.`)));
              if (info.type !== "Directory")
                return yield* new WorkspaceError({ message: `${cwd} isn't a folder.` });
              return rankEntries(yield* Cache.get(listings, path.resolve(cwd)), query, limit);
            }),

          saveAttachment: (name, mediaType, data) =>
            Effect.gen(function* () {
              const bytes = yield* Result.match(Base64.decode(data), {
                onFailure: () => Effect.fail(new WorkspaceError({ message: "The file couldn't be read." })),
                onSuccess: Effect.succeed,
              });
              if (bytes.length > MAX_FILE_BYTES) {
                return yield* new WorkspaceError({ message: "Files over 25 MB can't be attached." });
              }
              // A folder per file keeps its name as the user saw it, without collisions.
              const folder = path.join(
                options.attachmentsDirectory,
                yield* crypto.randomUUIDv7().pipe(Effect.orDie),
              );
              const file = path.join(folder, safeFileName(name));
              yield* fs
                .makeDirectory(folder, { recursive: true })
                .pipe(
                  Effect.andThen(fs.writeFile(file, bytes)),
                  Effect.mapError(refuse(`The file couldn't be saved.`)),
                );
              return { path: file, name: safeFileName(name), mediaType } satisfies Attachment;
            }),

          readImage: (file) =>
            Effect.gen(function* () {
              const mediaType = imageType(file);
              if (mediaType === undefined)
                return yield* new WorkspaceError({ message: `${file} isn't an image.` });
              const info = yield* fs.stat(file).pipe(Effect.mapError(refuse(`${file} doesn't exist.`)));
              if (Number(info.size) > MAX_FILE_BYTES) {
                return yield* new WorkspaceError({ message: `${file} is too large to show.` });
              }
              const bytes = yield* fs
                .readFile(file)
                .pipe(Effect.mapError(refuse(`${file} couldn't be read.`)));
              return { mediaType, data: Base64.encode(bytes) } satisfies ImageData;
            }),
        });
      }),
    );
}
