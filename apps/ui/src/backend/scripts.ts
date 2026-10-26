import { Atom } from "effect/reactivity";

import { Backend, connectionEpochAtom } from "./client.ts";

// A project's setup and run commands: what the run button, the palette and Source control's script
// fields resolve and show. The server resolves each time from the user's saved choice, the
// project's `.cerium.toml`, then a guess; a guessed one is shown to confirm, never run alone.

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

/** Starts one of a work thread's own commands in a thread terminal, taking the same kind's place. */
export const runProjectScript = Backend.mutation("RunProjectScript");
