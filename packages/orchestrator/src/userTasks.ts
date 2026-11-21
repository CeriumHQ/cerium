import {
  MAX_TASK_BYTES,
  MAX_TASK_NOTE,
  MAX_TASK_TITLE,
  type AgentId,
  type TaskEntry,
} from "@cerium/protocol";
import { Clock, Effect, Schema } from "effect";

import type { OrchestratorContext } from "./context.ts";
import { notAllowed, notFound, OrchestratorError } from "./errors.ts";
import { isAdvisor } from "./runtime.ts";

/** The user's tasks list as agents see it: `list_tasks`, `add_task` and `remove_task`. */
export const makeUserTasks = (ctx: OrchestratorContext) => {
  const { makeId, runtime, emit } = ctx;

  /**
   * What the windows mirroring in say the user's tasks list holds, plus what agents added while
   * they worked: the view `list_tasks` reads and `remove_task` matches titles against. A copy,
   * merged newer-wins like the window's own (`applyTaken` in the UI): the window's list is the
   * truth, and its next mirror overwrites anything this found out earlier. Deleted tasks keep
   * their stamps (no `task`) a while, so a mirror older than a delete can't bring one back.
   */
  const mirroredTasks = new Map<string, TaskEntry>();

  /** The `add_task` and `remove_task` caller rules: live, part of a thread, neither read-only nor the advisor. */
  const tasksWriterOf = (callerId: AgentId) =>
    Effect.gen(function* () {
      const caller = yield* runtime(callerId);
      if (isAdvisor(caller.info)) {
        return yield* notAllowed("You are the advisor: answer the question you were asked.");
      }
      if (caller.info.access === "readOnly") {
        return yield* notAllowed("A read-only agent may only read the tasks list.");
      }
      return caller;
    });

  /** Enters the mirror a task entry stamped past the newest edit it knew of: a same-millisecond
   * edit wins, as the window's own (`stampAfter`) does. */
  const putTask = (change: { readonly id: string; readonly task?: Schema.Json }) =>
    Effect.gen(function* () {
      const stamped: TaskEntry = {
        id: change.id,
        updatedAt: Math.max(
          yield* Clock.currentTimeMillis,
          (mirroredTasks.get(change.id)?.updatedAt ?? 0) + 1,
        ),
        ...(change.task === undefined ? {} : { task: change.task }),
      };
      mirroredTasks.set(stamped.id, stamped);
      return stamped;
    });

  /** The one task `title` names, whatever its case and spacing; `notFound` when none, and when
   * several: the agent names one by its id then. */
  const taskByTitle = (title: string) => {
    const wanted = title.trim().toLowerCase();
    const matching = [...mirroredTasks.values()].filter((entry) => {
      const task = entry.task;
      const named =
        typeof task === "object" && task !== null && !Array.isArray(task)
          ? (task as { readonly title?: unknown }).title
          : undefined;
      return typeof named === "string" && named.trim().toLowerCase() === wanted;
    });
    if (matching.length <= 1) return Effect.succeed(matching[0]);
    return new OrchestratorError({
      reason: "invalid",
      message: `The list has ${matching.length} tasks titled \u201C${title.trim()}\u201D (${matching
        .map((entry) => entry.id)
        .join(", ")}). Pass one's id from \`list_tasks\`.`,
    });
  };

  const syncUserTasks = Effect.fn("Orchestrator.syncUserTasks")((tasks: ReadonlyArray<TaskEntry>) =>
    Effect.sync(() => {
      for (const entry of tasks) {
        const held = mirroredTasks.get(entry.id);
        if (held === undefined || entry.updatedAt > held.updatedAt) {
          mirroredTasks.set(entry.id, entry);
        }
      }
    }),
  );

  const addUserTask = Effect.fn("Orchestrator.addUserTask")(function* (
    callerId: AgentId,
    task: { readonly title: string; readonly note?: string; readonly folder?: string },
  ) {
    const caller = yield* tasksWriterOf(callerId);
    const title = task.title.trim();
    const note = task.note?.trim();
    const folder = task.folder?.trim();
    if (title === "") {
      return yield* new OrchestratorError({ reason: "invalid", message: "Name the task." });
    }
    if (title.length > MAX_TASK_TITLE) {
      return yield* new OrchestratorError({
        reason: "invalid",
        message: `The title may be ${MAX_TASK_TITLE} characters at most.`,
      });
    }
    if ((note ?? "").length > MAX_TASK_NOTE) {
      return yield* new OrchestratorError({
        reason: "invalid",
        message: `The note may be ${MAX_TASK_NOTE} characters at most.`,
      });
    }
    const createdAt = yield* Clock.currentTimeMillis;
    const content: Record<string, Schema.Json> = { title, createdAt };
    if (note) content.note = note;
    if (folder) content.folder = folder;
    if (JSON.stringify(content).length > MAX_TASK_BYTES) {
      return yield* new OrchestratorError({ reason: "invalid", message: "The task is too long." });
    }
    const entry = yield* putTask({
      id: yield* makeId("task"),
      task: content as Schema.Json,
    });
    yield* emit(caller, { _tag: "UserTasksChanged", tasks: [entry] });
    return entry;
  });

  const removeUserTask = Effect.fn("Orchestrator.removeUserTask")(function* (
    callerId: AgentId,
    which: { readonly id?: string; readonly title?: string },
  ) {
    const caller = yield* tasksWriterOf(callerId);
    const entry =
      which.title === undefined ? mirroredTasks.get(which.id ?? "") : yield* taskByTitle(which.title);
    if (entry === undefined || entry.task === undefined) {
      return yield* notFound(
        "No task like that is on the list. See `list_tasks` for the ids and titles it holds.",
      );
    }
    const gone = yield* putTask({ id: entry.id });
    yield* emit(caller, { _tag: "UserTasksChanged", tasks: [gone] });
    return gone;
  });

  const userTasks = Effect.suspend(() =>
    Effect.succeed([...mirroredTasks.values()].filter((entry) => entry.task !== undefined)),
  );

  return {
    syncUserTasks,
    addUserTask,
    removeUserTask,
    userTasks,
  };
};
