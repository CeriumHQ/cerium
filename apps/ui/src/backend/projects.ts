import { Effect } from "effect";
import { Atom } from "effect/reactivity";

import { Backend, connectionAtom } from "./client.ts";

// The folders the composer offers to work in, and what the inbox shows about a work thread's
// folder, keyed by the folder's path.

/** The saved projects, most recently used first. Re-read whenever the project picker opens. */
export const savedProjectsAtom = Backend.runtime.atom((get) => {
  get(connectionAtom);
  return Backend.use((client) => client("ListProjects", undefined));
});

export const saveProject = Backend.mutation("SaveProject");
export const removeProject = Backend.mutation("RemoveProject");

/**
 * The branch checked out in a folder (a short commit when detached); undefined outside git, and for
 * no folder (`""`).
 */
export const gitBranchAtom = Atom.family((cwd: string) =>
  Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      return cwd === ""
        ? Effect.succeed<string | undefined>(undefined)
        : Backend.use((client) => client("GitBranch", { cwd })).pipe(Effect.map(({ branch }) => branch));
    })
    .pipe(Atom.setIdleTTL("1 minute")),
);

/** What a thread's worktree holds that its base doesn't, asked for before archiving it. */
export const worktreeChanges = Backend.mutation("WorktreeChanges");

/** The project's own icon as a data URL; undefined when it has none. Rarely changes, so kept a while. */
export const projectIconAtom = Atom.family((cwd: string) =>
  Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      return Backend.use((client) => client("ProjectIcon", { cwd })).pipe(
        Effect.map(({ icon }) => (icon ? `data:${icon.mediaType};base64,${icon.data}` : undefined)),
      );
    })
    .pipe(Atom.setIdleTTL("10 minutes")),
);
