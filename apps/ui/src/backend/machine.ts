import type { DeviceId, DeviceInfo } from "@cerium/protocol";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { remember, stored } from "../lib/storage.ts";
import { WEB } from "./target.ts";

// The machine this window drives (docs/architecture.md §14.8): this computer, or another desktop of
// the account, reached through this computer's backend and the relay. Every RPC but the account's
// goes there; the window always starts on this computer. The web client has no computer of its own,
// so it drives one of the account's desktops, the one it drove last when it can (§14.10).

/** The desktop the web client drove last. */
const LAST_MACHINE_KEY = "cerium:machine";

export interface DrivenMachine {
  readonly id: DeviceId;
  readonly name: string;
}

/** The other machine the window drives, or none for this computer. */
export const machineAtom = Atom.make<DrivenMachine | undefined>(undefined).pipe(Atom.keepAlive);

let driving: DrivenMachine | undefined;
const listeners = new Set<() => void>();

/** For code outside React: the machine driven right now. */
export const drivenMachine = () => driving;

/** Switches the window to another machine, or back to this computer with none. */
export const driveMachine = (registry: AtomRegistry.AtomRegistry, machine: DrivenMachine | undefined) => {
  if (machine?.id === driving?.id) return;
  driving = machine;
  if (WEB && machine !== undefined) remember(LAST_MACHINE_KEY, machine.id);
  registry.set(machineAtom, machine);
  for (const listener of listeners) listener();
};

/** Calls back whenever the driven machine changes; returns how to stop. */
export const onMachineChange = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** A per-machine name for something the window remembers, such as the last folder. */
export const machineKey = (key: string, machine: DrivenMachine | undefined) =>
  machine === undefined ? key : `${key}:${machine.id}`;

/**
 * The desktop the web client should drive among the account's `reachable` ones: the one it drove
 * last, else the first. None while none can be reached.
 */
export const machineToDrive = (reachable: ReadonlyArray<DeviceInfo>): DrivenMachine | undefined => {
  const last = stored(LAST_MACHINE_KEY);
  const pick = reachable.find((device) => device.id === last) ?? reachable[0];
  return pick === undefined ? undefined : { id: pick.id, name: pick.name };
};
