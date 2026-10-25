import { MAX_TASK_BYTES, type TaskEntry } from "@cerium/protocol";
import { Option, Schema } from "effect";
import { Atom } from "effect/reactivity";

import { remember, stored } from "../../lib/storage.ts";

// The user's own tasks (the rail's Tasks): what they mean to do, ticked off once done. They live in
// the window's local storage, deleted ones as a stamp a while, and signed in they follow the user to
// the account's other devices, each task's latest edit winning (`useTaskSync.ts`).

const TASKS_KEY = "cerium:tasks";

/** What a task holds. Stored as written, so what a newer version adds to one survives this one's edits. */
const TaskContent = Schema.Struct({
  title: Schema.String,
  note: Schema.optionalKey(Schema.String),
  createdAt: Schema.Finite,
  /** When it was ticked off; absent while it's still to do. */
  doneAt: Schema.optionalKey(Schema.Finite),
  /** The project an agent handed it works in. */
  folder: Schema.optionalKey(Schema.String),
});
type TaskContent = typeof TaskContent.Type;

const decodeContent = Schema.decodeUnknownOption(TaskContent);

export interface Task extends TaskContent {
  readonly id: string;
}

/** Every task this window knows by id, deleted ones (no `task`) included while their stamp is kept. */
export type TaskStore = Readonly<Record<string, TaskEntry>>;

/** How long a deleted task's stamp is kept, against a device that was offline bringing it back. */
const GONE_KEPT_MS = 30 * 24 * 60 * 60 * 1000;

const StoredEntry = Schema.Struct({
  updatedAt: Schema.Finite,
  task: Schema.optionalKey(Schema.Json),
});

/** The tasks storage holds; an entry that no longer reads is dropped without losing the others. */
export const parseTasks = (text: string | undefined): TaskStore => {
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const decode = Schema.decodeUnknownOption(StoredEntry);
  return Object.fromEntries(
    Object.entries(parsed).flatMap(([id, value]) =>
      Option.match(decode(value), {
        onNone: () => [],
        onSome: (entry): Array<[string, TaskEntry]> => [[id, { id, ...entry }]],
      }),
    ),
  );
};

const serializeTasks = (tasks: TaskStore): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.values(tasks).map(({ id, updatedAt, task }) => [
        id,
        task === undefined ? { updatedAt } : { updatedAt, task },
      ]),
    ),
  );

/** The tasks that read, to do and done. */
export const listTasks = (tasks: TaskStore): ReadonlyArray<Task> =>
  Object.values(tasks).flatMap((entry) =>
    entry.task === undefined
      ? []
      : Option.match(decodeContent(entry.task), {
          onNone: () => [],
          onSome: (content): Array<Task> => [{ ...content, id: entry.id }],
        }),
  );

/** Still to do, the newest first; done, the latest ticked off first. */
export const splitTasks = (tasks: ReadonlyArray<Task>) => ({
  open: tasks.filter((task) => task.doneAt === undefined).toSorted((a, b) => b.createdAt - a.createdAt),
  done: tasks
    .filter((task) => task.doneAt !== undefined)
    .toSorted((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)),
});

/** `tasks` without deleted tasks' stamps past their time. */
const pruned = (tasks: TaskStore, now: number): TaskStore => {
  const gone = Object.values(tasks).filter(
    (entry) => entry.task === undefined && entry.updatedAt < now - GONE_KEPT_MS,
  );
  if (gone.length === 0) return tasks;
  const kept = { ...tasks };
  for (const { id } of gone) delete kept[id];
  return kept;
};

/** A stamp after the task's last, so an edit always counts as the latest even if the clock lags. */
const stampAfter = (tasks: TaskStore, id: string, now: number) =>
  Math.max(now, (tasks[id]?.updatedAt ?? 0) + 1);

/** `tasks` with a new one called `title`, and its id. */
export const addTask = (
  tasks: TaskStore,
  title: string,
  now: number,
  id: string = crypto.randomUUID(),
): TaskStore => {
  const content: TaskContent = { title, createdAt: now };
  return pruned({ ...tasks, [id]: { id, updatedAt: now, task: content } }, now);
};

/** What an edit changes of a task; `undefined` clears a field. */
export type TaskPatch = {
  readonly [K in Exclude<keyof TaskContent, "createdAt">]?: TaskContent[K] | undefined;
};

/** `tasks` with `id`'s task changed, keeping whatever a newer version wrote into it. */
export const editTask = (tasks: TaskStore, id: string, patch: TaskPatch, now: number): TaskStore => {
  const entry = tasks[id];
  const task = entry?.task;
  if (task === undefined || task === null || typeof task !== "object" || Array.isArray(task)) return tasks;
  const next: Record<string, Schema.Json> = Object.fromEntries(Object.entries(task));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return pruned({ ...tasks, [id]: { id, updatedAt: stampAfter(tasks, id, now), task: next } }, now);
};

/** `tasks` with `id`'s task ticked off at `now`, or back to do. */
export const tickTask = (tasks: TaskStore, id: string, done: boolean, now: number): TaskStore =>
  editTask(tasks, id, { doneAt: done ? now : undefined }, now);

/** `tasks` with `id`'s task deleted: its stamp stays a while, so it doesn't come back. */
export const deleteTask = (tasks: TaskStore, id: string, now: number): TaskStore =>
  tasks[id] === undefined
    ? tasks
    : pruned({ ...tasks, [id]: { id, updatedAt: stampAfter(tasks, id, now) } }, now);

/** What the window takes from the account's tasks, and what it sends of its own. */
export const reconcileTasks = (
  local: TaskStore,
  cloud: ReadonlyArray<TaskEntry>,
): { readonly take: ReadonlyArray<TaskEntry>; readonly send: ReadonlyArray<TaskEntry> } => {
  const inCloud = new Map(cloud.map((entry) => [entry.id, entry.updatedAt]));
  const take = cloud.filter((entry) => entry.updatedAt > (local[entry.id]?.updatedAt ?? 0));
  const send = Object.values(local).filter(
    (entry) =>
      entry.updatedAt > (inCloud.get(entry.id) ?? 0) &&
      // A task deleted before it was ever shared has nothing to tell.
      (entry.task !== undefined || inCloud.has(entry.id)) &&
      JSON.stringify(entry.task ?? null).length <= MAX_TASK_BYTES,
  );
  return { take, send };
};

/** `tasks` with what was taken from the account's. */
export const applyTaken = (tasks: TaskStore, take: ReadonlyArray<TaskEntry>): TaskStore =>
  take.length === 0 ? tasks : { ...tasks, ...Object.fromEntries(take.map((entry) => [entry.id, entry])) };

/** The window's tasks, kept in local storage and in step with its other tabs. */
export const tasksAtom: Atom.Writable<TaskStore> = Atom.writable(
  (get): TaskStore => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === TASKS_KEY) get.setSelf(parseTasks(event.newValue ?? undefined));
    };
    window.addEventListener("storage", onStorage);
    get.addFinalizer(() => window.removeEventListener("storage", onStorage));
    return parseTasks(stored(TASKS_KEY));
  },
  (context, tasks: TaskStore) => {
    context.setSelf(tasks);
    remember(TASKS_KEY, serializeTasks(tasks));
  },
).pipe(Atom.keepAlive);
