import type { ImageData, ProjectInfo } from "@cerium/protocol";
import { Store, type StoreError } from "@cerium/store";
import { Cache, Clock, Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { Base64 } from "effect/encoding";

// The folders the composer offers to work in, and what the sidebar shows about a work thread's
// folder: the git branch checked out there, and the project's own icon when it has one.

/** Icons this large are artwork, not a mark; a mark that isn't small enough isn't worth the socket. */
const MAX_ICON_BYTES = 512 * 1024;

/** Square marks first: a favicon is drawn for small sizes, a logo is often a wide wordmark. */
const ICON_NAMES = [
  "favicon.svg",
  "favicon.png",
  "favicon.ico",
  "icon.svg",
  "icon.png",
  "logo.svg",
  "logo.png",
];

const mediaTypes: Readonly<Record<string, string>> = {
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
};

/** Where projects keep them: the root, web roots, framework app folders, asset and build folders. */
const ICON_FOLDERS = [
  "",
  "public",
  "static",
  "app",
  "src",
  "src/app",
  "assets",
  "src/assets",
  "resources",
  "build",
  ".github",
  ".idea",
];

/** Monorepos keep their packages here; each package is searched like a project of its own. */
const WORKSPACE_FOLDERS = ["apps", "packages"];

/** The branch a `HEAD` file names, or the short commit a detached `HEAD` points at. */
export const branchFromHead = (head: string): string | undefined => {
  const text = head.trim();
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
  if (ref) return ref[1];
  return /^[0-9a-f]{7,}$/i.test(text) ? text.slice(0, 7) : undefined;
};

/** Where a `.git` file (a worktree's or a submodule's) says the repository's git folder is. */
export const gitDirFromFile = (contents: string): string | undefined =>
  /^gitdir:\s*(.+)$/m.exec(contents)?.[1]?.trim();

/** A folder the backend won't save as a project; `message` is written for the user. */
export class ProjectError extends Schema.TaggedError<ProjectError>()("ProjectError", {
  message: Schema.String,
}) {}

export class Projects extends Context.Service<
  Projects,
  {
    /** The saved project folders, most recently used first, each marked when it is gone. */
    readonly list: Effect.Effect<ReadonlyArray<ProjectInfo>, StoreError>;
    /** Saves a folder as a project, or marks a saved one as just used. Refuses what isn't a folder. */
    save(folder: string): Effect.Effect<ProjectInfo, ProjectError | StoreError>;
    /** Forgets a project; threads that ran in it keep their folder. */
    remove(folder: string): Effect.Effect<void, StoreError>;
    /** The branch checked out in `cwd`, or the short commit when detached; none outside git. */
    branch(cwd: string): Effect.Effect<string | undefined>;
    /** The project's own icon, when it has a favicon, icon or logo where projects keep them. */
    icon(cwd: string): Effect.Effect<ImageData | undefined>;
  }
>()("cerium/backend/Projects") {
  /** Requires `Store`, `FileSystem` and `Path`. */
  static readonly layer = Layer.effect(
    Projects,
    Effect.gen(function* () {
      const store = yield* Store;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const isFolder = (folder: string) =>
        fs.stat(folder).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        );

      const isFile = (file: string) =>
        fs.stat(file).pipe(
          Effect.map((info) => info.type === "File" && Number(info.size) <= MAX_ICON_BYTES),
          Effect.orElseSucceed(() => false),
        );

      /** The git folder for `cwd`: its own `.git`, or the nearest one above it. */
      const gitDir = Effect.fn("Projects.gitDir")(function* (cwd: string) {
        let folder = path.resolve(cwd);
        while (true) {
          const dotGit = path.join(folder, ".git");
          const info = yield* Effect.option(fs.stat(dotGit));
          if (Option.isSome(info)) {
            if (info.value.type === "Directory") return dotGit;
            const pointer = gitDirFromFile(yield* fs.readFileString(dotGit));
            return pointer === undefined ? undefined : path.resolve(folder, pointer);
          }
          const parent = path.dirname(folder);
          if (parent === folder) return undefined;
          folder = parent;
        }
      });

      const findIcon = Effect.fn("Projects.findIcon")(function* (cwd: string) {
        const roots = [cwd];
        for (const workspace of WORKSPACE_FOLDERS) {
          const names = yield* fs
            .readDirectory(path.join(cwd, workspace))
            .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
          roots.push(...names.toSorted().map((name) => path.join(cwd, workspace, name)));
        }
        for (const root of roots) {
          for (const name of ICON_NAMES) {
            for (const folder of ICON_FOLDERS) {
              const file = path.join(root, folder, name);
              if (!(yield* isFile(file))) continue;
              const bytes = yield* Effect.option(fs.readFile(file));
              if (Option.isNone(bytes)) continue;
              return { mediaType: mediaTypes[name.split(".")[1]!]!, data: Base64.encode(bytes.value) };
            }
          }
        }
        return undefined;
      });

      // Searching for an icon reads dozens of paths and the answer rarely changes.
      const icons = yield* Cache.make({
        capacity: 64,
        timeToLive: "5 minutes",
        lookup: (cwd: string) => findIcon(cwd).pipe(Effect.orElseSucceed(() => undefined)),
      });

      return Projects.of({
        list: store.listProjects.pipe(
          Effect.flatMap((saved) =>
            Effect.forEach(
              saved,
              ({ path: folder, usedAt }) =>
                isFolder(folder).pipe(
                  Effect.map((exists): ProjectInfo =>
                    exists ? { path: folder, usedAt } : { path: folder, usedAt, missing: true },
                  ),
                ),
              { concurrency: 8 },
            ),
          ),
        ),
        save: Effect.fn("Projects.save")(function* (folder: string) {
          if (!(yield* isFolder(folder))) {
            return yield* new ProjectError({ message: `${folder} isn't a folder Cerium can open.` });
          }
          const usedAt = yield* Clock.currentTimeMillis;
          yield* store.saveProject(folder, usedAt);
          return { path: folder, usedAt };
        }),
        remove: (folder) => store.removeProject(folder),
        branch: (cwd) =>
          Effect.gen(function* () {
            const dir = yield* gitDir(cwd);
            if (dir === undefined) return undefined;
            return branchFromHead(yield* fs.readFileString(path.join(dir, "HEAD")));
          }).pipe(Effect.orElseSucceed(() => undefined)),
        icon: (cwd) => Cache.get(icons, path.resolve(cwd)),
      });
    }),
  );
}
