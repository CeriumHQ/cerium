import { EpochMillis } from "./ids.ts";
import { Schema } from "effect";

// The user's own tasks (the rail's Tasks): shared by the account's devices through the relay and,
// on the machine a thread runs on, editable by its agents with the bus's `add_task` and
// `remove_task`, which carry entries like these.

/**
 * One of the user's own tasks (the rail's Tasks), as the account's devices share it: keyed by an id
 * its device made, and gone (`task` absent) once deleted. The most recent edit wins. Like a draft's,
 * its content is the UI's to read, so the relay keeps whatever a newer version writes into it.
 */
export const TaskEntry = Schema.Struct({
  id: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  updatedAt: EpochMillis,
  task: Schema.optionalKey(Schema.Json),
});
export type TaskEntry = typeof TaskEntry.Type;

/** The relay keeps a task only while its content stays under this size. */
export const MAX_TASK_BYTES = 32_000;

/** What the task's own editor bounds its fields to, and the bus's `add_task` with them. */
export const MAX_TASK_TITLE = 500;
export const MAX_TASK_NOTE = 20_000;
