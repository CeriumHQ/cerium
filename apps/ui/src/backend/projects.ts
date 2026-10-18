import { Effect } from "effect";
import { Atom } from "effect/reactivity";

import { activityAtom } from "./atoms.ts";
import { Backend, connectionAtom } from "./client.ts";

// What the inbox shows about a work thread's folder, keyed by the folder's path.

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

/** The branch checked out in the folder. Agents and the user switch branches, so it re-reads as they work. */
export const gitBranchAtom = Atom.family((cwd: string) =>
  Backend.runtime.atom((get) => {
    get(connectionAtom);
    get(activityAtom);
    return Backend.use((client) => client("GitBranch", { cwd })).pipe(Effect.map(({ branch }) => branch));
  }),
);
