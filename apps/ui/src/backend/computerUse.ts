import type { ComputerUseStatus } from "@cerium/protocol";
import { Effect, Schedule, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { accountAtom } from "./atoms.ts";
import { Backend } from "./client.ts";
import { machineAtom } from "./machine.ts";

// Computer use on the driven machine: whether agent-desktop is ready there, the system's
// permission, and which of its agents are using the computer, so the user can see and stop them.

/** The `RPC_VERSION` that brought computer use; an older machine has none. */
export const COMPUTER_USE_VERSION = 49;

/** Whether the driven machine offers computer use: this computer always, another from `COMPUTER_USE_VERSION`. */
export const computerUseOfferedAtom = Atom.make((get) => {
  const machine = get(machineAtom);
  if (machine === undefined) return true;
  const state = AsyncResult.getOrElse(get(accountAtom), () => undefined);
  return (
    state?._tag === "SignedIn" &&
    (state.devices.find((device) => device.id === machine.id)?.rpcVersion ?? 0) >= COMPUTER_USE_VERSION
  );
});

/** Computer use on the driven machine, now and after every change; nothing from a machine without it. */
export const computerUseAtom = Backend.runtime
  .atom((get) => {
    if (!get(computerUseOfferedAtom)) return Stream.empty as Stream.Stream<ComputerUseStatus>;
    return Stream.unwrap(Backend.use((client) => Effect.succeed(client("WatchComputerUse", undefined)))).pipe(
      Stream.retry(Schedule.spaced("2 seconds")),
    );
  })
  .pipe(Atom.setIdleTTL("1 minute"));

export const installComputerUse = Backend.mutation("InstallComputerUse");
export const openComputerPermissions = Backend.mutation("OpenComputerPermissions");
export const stopComputerUse = Backend.mutation("StopComputerUse");
