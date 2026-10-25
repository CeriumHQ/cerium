import type { TaskEntry } from "@cerium/protocol";
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useEffectEvent } from "react";

import { accountTasksAtom, saveTasks } from "../../backend/atoms.ts";
import { applyTaken, reconcileTasks, tasksAtom } from "./tasks.ts";

/** How long editing pauses before the latest edit goes to the account's other devices. */
const SEND_AFTER_MS = 600;

/** How much of a message to the relay tasks may fill; the rest goes in the next. */
const BATCH_BYTES = 768_000;

const batches = (entries: ReadonlyArray<TaskEntry>): ReadonlyArray<ReadonlyArray<TaskEntry>> => {
  const out: Array<Array<TaskEntry>> = [];
  let size = 0;
  for (const entry of entries) {
    const bytes = JSON.stringify(entry).length;
    const last = out.at(-1);
    if (last === undefined || size + bytes > BATCH_BYTES) {
      out.push([entry]);
      size = bytes;
    } else {
      last.push(entry);
      size += bytes;
    }
  }
  return out;
};

/**
 * Keeps the window's tasks in step with the account's other devices while signed in: what the
 * account holds newer is taken, and what's newer here is sent. Renders nothing.
 */
export function TaskSync({ signedIn }: { signedIn: boolean }) {
  const registry = useContext(RegistryContext);
  const cloud = AsyncResult.getOrElse(useAtomValue(accountTasksAtom), () => undefined);
  const tasks = useAtomValue(tasksAtom);
  const save = useAtomSet(saveTasks, { mode: "promise" });
  const ready = signedIn && cloud?.ready === true;

  const sync = useEffectEvent(() => {
    if (!ready || cloud === undefined) return;
    const { take, send } = reconcileTasks(registry.get(tasksAtom), cloud.tasks);
    if (take.length > 0) registry.set(tasksAtom, applyTaken(registry.get(tasksAtom), take));
    // Unsent, a task goes the next time the account's tasks or this window's change.
    for (const batch of batches(send)) void save({ payload: { tasks: batch } }).catch(() => undefined);
  });

  // What the account says is taken at once; what's written here goes once writing pauses.
  useEffect(() => sync(), [ready, cloud]);
  useEffect(() => {
    const timer = setTimeout(sync, SEND_AFTER_MS);
    return () => clearTimeout(timer);
  }, [tasks]);
  return null;
}
