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

/** How well `entry` matches `query` (lower is better), or undefined when it doesn't. */
const score = (entry: WorkspaceEntry, query: string): number | undefined => {
  const path = entry.path.toLowerCase();
  const name = baseName(path);
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
  entries: ReadonlyArray<WorkspaceEntry>,
  query: string,
  limit: number,
): ReadonlyArray<WorkspaceEntry> => {
  const wanted = query.trim().toLowerCase().replaceAll("\\", "/");
  if (wanted === "") {
    return entries
      .filter((entry) => depth(entry.path) === 1)
      .toSorted((a, b) => Number(b.folder) - Number(a.folder) || a.path.localeCompare(b.path))
      .slice(0, limit);
  }
  return entries
    .flatMap((entry) => {
      const rank = score(entry, wanted);
      return rank === undefined ? [] : [{ entry, rank }];
    })
    .toSorted(
      (a, b) =>
        a.rank - b.rank ||
        depth(a.entry.path) - depth(b.entry.path) ||
        a.entry.path.length - b.entry.path.length ||
        a.entry.path.localeCompare(b.entry.path),
    )
    .slice(0, limit)
    .map(({ entry }) => entry);
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
