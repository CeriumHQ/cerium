import {
  MAX_TASK_BYTES,
  MAX_TASK_NOTE,
  MAX_TASK_TITLE,
  type AgentEvent,
  type TaskEntry,
} from "@cerium/protocol";
import { Option, Schema } from "effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

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
  threadIds: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
});
type TaskContent = typeof TaskContent.Type;

const decodeContent = Schema.decodeUnknownOption(TaskContent);

export interface Task extends TaskContent {
  readonly id: string;
}

export type NewTask = Pick<Task, "title" | "note" | "folder" | "threadIds">;

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

const readTask = (entry: TaskEntry | undefined): Task | undefined =>
  entry?.task === undefined
    ? undefined
    : Option.map(decodeContent(entry.task), (content) => ({ ...content, id: entry.id })).pipe(
        Option.getOrUndefined,
      );

/** The tasks that read, to do and done. */
export const listTasks = (tasks: TaskStore): ReadonlyArray<Task> =>
  Object.values(tasks)
    .map(readTask)
    .filter((task) => task !== undefined);

/** Still to do, the newest first; done, the latest ticked off first. */
export const splitTasks = (tasks: ReadonlyArray<Task>) => ({
  open: tasks.filter((task) => task.doneAt === undefined).toSorted((a, b) => b.createdAt - a.createdAt),
  done: tasks
    .filter((task) => task.doneAt !== undefined)
    .toSorted((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)),
});

/** `undefined` means all projects and `null` means tasks with no project. */
export const tasksInProject = (tasks: ReadonlyArray<Task>, project: string | null | undefined) =>
  project === undefined ? tasks : tasks.filter(({ folder }) => (folder ?? null) === project);

/** Thread ids are globally unique. The same relationship drives both sides of the UI. */
export const linkedTasks = (tasks: ReadonlyArray<Task>, threadId: string): ReadonlyArray<Task> =>
  tasks.filter((task) => task.threadIds?.includes(threadId));

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

/** `tasks` with a new task, including any source note, project and thread links. */
export const addTask = (
  tasks: TaskStore,
  input: string | NewTask,
  now: number,
  id: string = crypto.randomUUID(),
): TaskStore => {
  const info = typeof input === "string" ? { title: input } : input;
  const content: TaskContent = { ...info, createdAt: now };
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

/** Links only tasks that still exist, and considers repeated links a no-op. */
export const linkTaskThreads = (
  tasks: TaskStore,
  taskId: string,
  threadIds: ReadonlyArray<string>,
  now: number,
  folder?: string,
): TaskStore => {
  const task = readTask(tasks[taskId]);
  if (task === undefined || threadIds.length === 0) return tasks;
  const previous = task.threadIds ?? [];
  const next = [...new Set([...previous, ...threadIds.filter((id) => id !== "")])];
  if (next.length === previous.length && next.every((id, index) => id === previous[index])) return tasks;
  return editTask(
    tasks,
    taskId,
    { threadIds: next, ...(task.folder === undefined && folder ? { folder } : {}) },
    now,
  );
};

export const unlinkTaskThread = (
  tasks: TaskStore,
  taskId: string,
  threadId: string,
  now: number,
): TaskStore => {
  const previous = readTask(tasks[taskId])?.threadIds;
  if (!previous?.includes(threadId)) return tasks;
  const threadIds = previous.filter((id) => id !== threadId);
  return editTask(tasks, taskId, { threadIds: threadIds.length === 0 ? undefined : threadIds }, now);
};

export const unlinkDeletedThread = (tasks: TaskStore, threadId: string, now: number): TaskStore =>
  linkedTasks(listTasks(tasks), threadId).reduce(
    (remaining, task) => unlinkTaskThread(remaining, task.id, threadId, now),
    tasks,
  );

/** Offer to complete a task after the lead's latest turn finished successfully. */
export const leadFinished = (events: ReadonlyArray<AgentEvent>, leadId: string): boolean => {
  const latest = events.findLast(
    ({ agentId, payload }) =>
      agentId === leadId &&
      (payload._tag === "TurnCompleted" ||
        payload._tag === "TurnInput" ||
        payload._tag === "ConversationRewound"),
  )?.payload;
  return latest?._tag === "TurnCompleted" && latest.stopReason === "completed";
};

/** Captures the text as a note and links the task back to the conversation it came from. */
export const taskFromMessage = (text: string, threadId: string, folder?: string): NewTask => {
  const note = text.trim();
  return withCapturedNote(
    {
      title: note.split(/\r?\n/u, 1)[0]!.slice(0, MAX_TASK_TITLE),
      ...(folder === undefined ? {} : { folder }),
      threadIds: [threadId],
    },
    note,
  );
};

export const taskFromIssue = (
  issue: { readonly number: number; readonly title: string; readonly url: string; readonly body: string },
  folder: string,
): NewTask =>
  withCapturedNote(
    { title: `#${issue.number} ${issue.title}`.slice(0, MAX_TASK_TITLE), folder },
    `${issue.url}\n\n${issue.body.trim()}`.trimEnd(),
  );

/** Captured text can contain enough escapes to exceed the relay limit even within the note limit. */
const withCapturedNote = (task: Omit<NewTask, "note">, text: string): NewTask => {
  const note = text.slice(0, MAX_TASK_NOTE);
  const overhead = JSON.stringify({
    ...task,
    note: "",
    createdAt: Number.MAX_SAFE_INTEGER,
    doneAt: Number.MAX_SAFE_INTEGER,
  }).length;
  const room = MAX_TASK_BYTES - overhead;
  if (JSON.stringify(note).length - 2 <= room) return { ...task, note };
  let size = 0;
  let end = 0;
  for (const character of note) {
    size += JSON.stringify(character).length - 2;
    if (size > room) break;
    end += character.length;
  }
  return { ...task, note: note.slice(0, end) };
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

/** Creates a task from the latest store and returns the id to open. */
export const captureTask = (registry: AtomRegistry.AtomRegistry, task: NewTask): string => {
  const id = crypto.randomUUID();
  registry.set(tasksAtom, addTask(registry.get(tasksAtom), task, Date.now(), id));
  return id;
};
