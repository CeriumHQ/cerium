import type { ProviderId } from "@cerium/protocol";
import type { CommandTerminal } from "@cerium/rpc";
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause, Effect, Exit } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { useContext } from "react";

import { machineAtom } from "../../backend/machine.ts";
import { closeTerminal, harnessCommandAtom } from "../../backend/terminals.ts";
import { messageOf } from "../terminal/model.ts";
import { fittedSize } from "../terminal/session.ts";

// Harness updates under way, each in its own command terminal, side by side. They're kept here
// rather than in the row that started them, so leaving Settings and coming back finds them as they were.

export interface HarnessUpdate {
  readonly started: Promise<CommandTerminal>;
  /** The version it updates from: once the harness reports another, the update is behind it. */
  readonly from: string;
  readonly state: "running" | "updated" | "failed";
  /** Why the command couldn't start, where it didn't. */
  readonly failure?: string;
}

/** Keyed `machine/provider`: a window that drives another machine starts with none. */
const updatesAtom = Atom.make<ReadonlyMap<string, HarnessUpdate>>(new Map()).pipe(Atom.keepAlive);

/**
 * The driven machine's harness updates, and starting, stopping and settling them. `onChanged` checks
 * the harnesses again once one has updated.
 */
export function useHarnessUpdates(onChanged: () => void) {
  const machine = useAtomValue(machineAtom)?.name ?? "";
  const updates = useAtomValue(updatesAtom);
  const setUpdates = useAtomSet(updatesAtom);
  const registry = useContext(RegistryContext);
  // Each harness's own atom, so starting several at once doesn't interrupt one with the next.
  const run = (provider: ProviderId): Promise<CommandTerminal> => {
    const command = harnessCommandAtom(provider);
    registry.set(command, { action: "update", size: fittedSize() });
    return Effect.runPromiseExit(AtomRegistry.getResult(registry, command, { suspendOnWaiting: true })).then(
      (exit) => {
        if (Exit.isSuccess(exit)) return exit.value;
        throw Cause.squash(exit.cause);
      },
    );
  };
  const close = useAtomSet(closeTerminal, { mode: "promise" });
  const keyOf = (provider: ProviderId) => `${machine}/${provider}`;

  /** Replaces the provider's update, if it's still `expected`; says whether it was. */
  const replace = (
    provider: ProviderId,
    expected: Promise<CommandTerminal> | "any",
    next: HarnessUpdate | undefined,
  ) => {
    let replaced = false;
    setUpdates((all) => {
      const key = keyOf(provider);
      if (expected !== "any" && all.get(key)?.started !== expected) return all;
      replaced = true;
      const changed = new Map(all);
      if (next === undefined) changed.delete(key);
      else changed.set(key, next);
      return changed;
    });
    return replaced;
  };
  const letGo = (started: Promise<CommandTerminal>) =>
    void started.then((terminal) => close({ payload: { id: terminal.id } })).catch(() => undefined);

  return {
    of: (provider: ProviderId) => updates.get(keyOf(provider)),
    start: (provider: ProviderId, from: string) => {
      const previous = updates.get(keyOf(provider));
      if (previous !== undefined) letGo(previous.started);
      const started = run(provider);
      replace(provider, "any", { started, from, state: "running" });
      started.catch((error: unknown) => {
        replace(provider, started, { started, from, state: "failed", failure: messageOf(error) });
      });
    },
    /** Ends a running update, or puts away one that failed. */
    stop: (provider: ProviderId) => {
      const update = updates.get(keyOf(provider));
      if (update === undefined) return;
      letGo(update.started);
      replace(provider, update.started, undefined);
    },
    /** The update's command ended: a clean exit updated the harness, and a closed terminal was stopped. */
    ended: (provider: ProviderId, update: HarnessUpdate, code: number | undefined) => {
      if (update.state !== "running") return;
      const next: HarnessUpdate | undefined =
        code === undefined ? undefined : { ...update, state: code === 0 ? "updated" : "failed" };
      if (!replace(provider, update.started, next)) return;
      if (code === 0) {
        letGo(update.started);
        onChanged();
      }
    },
  };
}
