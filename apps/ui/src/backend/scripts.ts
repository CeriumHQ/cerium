import type { ProjectScripts } from "@cerium/rpc";
import { AsyncResult, Atom } from "effect/reactivity";

import { Backend, connectionEpochAtom } from "./client.ts";

// A project's setup and run commands, and its named actions: what the run button and its menu, the
// palette and the Project scripts card resolve and show. The server resolves each time from the
// user's saved choice, the project's `.cerium.toml`, then a guess (setup and run alone); a guessed
// one is shown to confirm, never run alone.

/** A project's resolved setup and run commands, for the fields and the buttons; keyed by its folder. */
export const projectScriptsAtom = Atom.family((project: string) =>
  Backend.runtime
    .atom((get) => {
      get(connectionEpochAtom);
      return Backend.use((client) => client("ProjectScripts", { project }));
    })
    .pipe(Atom.setIdleTTL("10 minutes")),
);

/** Saves what the user chose in Source control's script fields: a saved choice, `null` to defer, `""` off. */
export const setProjectScripts = Backend.mutation("SetProjectScripts");

/** Writes the card's commands into the project's `.cerium.toml`, for its team to share. */
export const writeProjectScriptsFile = Backend.mutation("WriteProjectScriptsFile");

/** Starts one of a work thread's own commands in a thread terminal, taking the same kind's place. */
export const runProjectScript = Backend.mutation("RunProjectScript");

/** Starts one of the project's named actions in a thread terminal labelled with its name. */
export const runProjectAction = Backend.mutation("RunProjectAction");

/** A project's resolved commands for a thread that has none to ask for: no project, no commands. */
export const noProjectScripts = Atom.make(AsyncResult.success<ProjectScripts>({}));
