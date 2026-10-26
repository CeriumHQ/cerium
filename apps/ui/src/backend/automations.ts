import { Effect, Schedule, Stream } from "effect";
import { Atom } from "effect/reactivity";

import { Backend } from "./client.ts";
import { machineAtom } from "./machine.ts";

// The driven machine's automations: prompts that start a work thread on a schedule or when CI fails
// on a pushed commit, run by that machine's backend while Cerium runs there.

/** The `RPC_VERSION` that brought automations; an older machine has none to show. */
export const AUTOMATIONS_VERSION = 36;

/** Every automation with its next time and last runs, now and after every change. */
export const automationsAtom = Backend.runtime
  .atom((get) => {
    get(machineAtom);
    return Stream.unwrap(Backend.use((client) => Effect.succeed(client("WatchAutomations", undefined)))).pipe(
      Stream.retry(Schedule.spaced("2 seconds")),
    );
  })
  .pipe(Atom.setIdleTTL("1 minute"));

export const saveAutomation = Backend.mutation("SaveAutomation");
export const pauseAutomation = Backend.mutation("PauseAutomation");
export const deleteAutomation = Backend.mutation("DeleteAutomation");
export const runAutomation = Backend.mutation("RunAutomation");
