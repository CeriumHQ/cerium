import type { TaskEntry } from "@cerium/protocol";
import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useEffectEvent } from "react";

import { accountTasksAtom, agentTaskEventsAtom, saveTasks, syncUserTasks } from "../../backend/atoms.ts";
import { applyTaken, reconcileTasks, tasksAtom, type TaskStore } from "./tasks.ts";

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
 * account holds newer is taken, and what's newer here is sent. Keeps the machine's agents' tools
 * (`list_tasks` and so on) reading this window's list: what it holds is mirrored out once writing
 * pauses, and what an agent added or removed (a `UserTasksChanged` event) is merged in here,
 * newest-wins. Renders nothing.
 */
export function TaskSync({ signedIn }: { signedIn: boolean }) {
  const registry = useContext(RegistryContext);
  const cloud = AsyncResult.getOrElse(useAtomValue(accountTasksAtom), () => undefined);
  const tasks = useAtomValue(tasksAtom);
  const fromAgents = AsyncResult.getOrElse(
    useAtomValue(agentTaskEventsAtom),
    () => new Map<string, TaskEntry>(),
  );
  const save = useAtomSet(saveTasks, { mode: "promise" });
  const mirror = useAtomSet(syncUserTasks, { mode: "promise" });
  const ready = signedIn && cloud?.ready === true;

  const send = useEffectEvent(() => {
    if (!ready || cloud === undefined) return;
    const { take, send } = reconcileTasks(registry.get(tasksAtom), cloud.tasks);
    if (take.length > 0) registry.set(tasksAtom, applyTaken(registry.get(tasksAtom), take));
    // Unsent, a task goes the next time the account's tasks or this window's change.
    for (const batch of batches(send)) void save({ payload: { tasks: batch } }).catch(() => undefined);
  });

  /** Mirrors the window's list onto the machine the window drives, whatever accounts it knows. */
  const mirrorOut = useEffectEvent(() => {
    const entries = Object.values(registry.get(tasksAtom) satisfies TaskStore);
    void mirror({ payload: { tasks: entries } }).catch(() => undefined);
  });

  /** Takes an agent's entries that are newer than what the window holds; the rest is old news. */
  const takeFromAgents = useEffectEvent((entries: ReadonlyMap<string, TaskEntry>) => {
    const local = registry.get(tasksAtom);
    const take = [...entries.values()].filter((entry) => entry.updatedAt > (local[entry.id]?.updatedAt ?? 0));
    if (take.length > 0) registry.set(tasksAtom, applyTaken(local, take));
  });

  // What the account says is taken at once; what's written here goes once writing pauses.
  useEffect(() => send(), [ready, cloud]);
  useEffect(() => {
    takeFromAgents(fromAgents);
  }, [fromAgents]);
  const sync = useEffectEvent(() => {
    send();
    mirrorOut();
  });
  useEffect(() => {
    const timer = setTimeout(sync, SEND_AFTER_MS);
    return () => clearTimeout(timer);
  }, [tasks]);
  // Once connected, the mirror goes whole, in case it lost a change while the line was down.
  useEffect(() => {
    mirrorOut();
  }, []);
  return null;
}
