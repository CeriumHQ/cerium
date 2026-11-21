import { describe, expect, it } from "@effect/vitest";
import {
  MAX_TASK_NOTE,
  MAX_TASK_TITLE,
  type AgentEvent,
  type AgentId,
  type EventId,
  type EventPayload,
  type ThreadId,
} from "@cerium/protocol";

import {
  addTask,
  applyTaken,
  deleteTask,
  editTask,
  leadFinished,
  linkedTasks,
  linkTaskThreads,
  listTasks,
  parseTasks,
  reconcileTasks,
  splitTasks,
  taskFromIssue,
  taskFromMessage,
  tasksInProject,
  tickTask,
  unlinkDeletedThread,
  unlinkTaskThread,
} from "../src/features/tasks/tasks.ts";

const DAY = 86_400_000;

describe("the user's tasks", () => {
  it("list what's to do newest first, and what's done by when it was ticked off", () => {
    let tasks = addTask({}, "first", 1, "a");
    tasks = addTask(tasks, "second", 2, "b");
    tasks = addTask(tasks, "third", 3, "c");
    tasks = tickTask(tasks, "a", true, 10);
    tasks = tickTask(tasks, "c", true, 11);
    const { open, done } = splitTasks(listTasks(tasks));
    expect(open.map((task) => task.id)).toEqual(["b"]);
    expect(done.map((task) => task.id)).toEqual(["c", "a"]);
    expect(splitTasks(listTasks(tickTask(tasks, "a", false, 12))).open.map((task) => task.id)).toEqual([
      "b",
      "a",
    ]);
  });

  it("keep what a newer version wrote into a task through this one's edits", () => {
    const tasks = {
      a: { id: "a", updatedAt: 5, task: { title: "old", createdAt: 1, due: "tomorrow" } },
    };
    const edited = editTask(tasks, "a", { title: "new", note: "more" }, 6);
    expect(edited["a"]).toEqual({
      id: "a",
      updatedAt: 6,
      task: { title: "new", createdAt: 1, due: "tomorrow", note: "more" },
    });
    expect(editTask(edited, "a", { note: undefined }, 7)["a"]?.task).toEqual({
      title: "new",
      createdAt: 1,
      due: "tomorrow",
    });
  });

  it("stamp an edit after the last even when the clock lags", () => {
    const tasks = addTask({}, "task", 100, "a");
    expect(editTask(tasks, "a", { title: "later" }, 50)["a"]?.updatedAt).toBe(101);
  });

  it("keep a deleted task's stamp a month, then forget it", () => {
    const deleted = deleteTask(addTask({}, "task", 1, "a"), "a", 2);
    expect(deleted["a"]).toEqual({ id: "a", updatedAt: 2 });
    expect(listTasks(deleted)).toEqual([]);
    expect(addTask(deleted, "another", 2 + 31 * DAY, "b")["a"]).toBeUndefined();
  });

  it("read back from storage, dropping what doesn't read", () => {
    const stored = JSON.stringify({
      a: { updatedAt: 1, task: { title: "kept", createdAt: 1 } },
      b: { updatedAt: 2 },
      c: { nonsense: true },
    });
    expect(parseTasks(stored)).toEqual({
      a: { id: "a", updatedAt: 1, task: { title: "kept", createdAt: 1 } },
      b: { id: "b", updatedAt: 2 },
    });
    expect(parseTasks("not json")).toEqual({});
  });
});

describe("links between tasks and threads", () => {
  it("uses the persisted relationship for both directions and syncs it with an account", () => {
    const tasks = addTask({}, "Fix login", 1, "a");
    const linked = linkTaskThreads(tasks, "a", ["thread-1", "thread-2", "thread-1"], 2, "/projects/app");
    expect(linkTaskThreads(linked, "a", ["thread-2"], 3)).toBe(linked);
    const { send } = reconcileTasks(linked, [tasks["a"]!]);
    const remote = applyTaken({}, send);
    const restored = parseTasks(JSON.stringify(remote));
    expect(listTasks(restored)).toEqual([
      {
        id: "a",
        title: "Fix login",
        createdAt: 1,
        folder: "/projects/app",
        threadIds: ["thread-1", "thread-2"],
      },
    ]);
    expect(linkedTasks(listTasks(restored), "thread-2").map(({ id }) => id)).toEqual(["a"]);
    expect(linkedTasks(listTasks(restored), "thread-3")).toEqual([]);
  });

  it("removes one relationship without losing others and unlinks a deleted thread from every task", () => {
    const a = addTask({}, { title: "One", threadIds: ["first", "second"] }, 1, "a");
    const both = addTask(a, { title: "Two", threadIds: ["first"] }, 2, "b");
    const unlinked = unlinkTaskThread(both, "a", "first", 3);
    expect(linkedTasks(listTasks(unlinked), "first").map(({ id }) => id)).toEqual(["b"]);
    expect(unlinkTaskThread(unlinked, "a", "first", 4)).toBe(unlinked);
    const deleted = unlinkDeletedThread(both, "first", 5);
    expect(listTasks(deleted).map(({ threadIds }) => threadIds)).toEqual([["second"], undefined]);
    expect(linkedTasks(listTasks(deleted), "first")).toEqual([]);
  });

  it("keeps links and the chosen project when marking done, and never revives a deleted task", () => {
    const task = addTask({}, { title: "Task", folder: "/original", threadIds: ["first"] }, 1, "a");
    const linked = linkTaskThreads(task, "a", ["second"], 2, "/new");
    const done = tickTask(linked, "a", true, 3);
    expect(linkedTasks(listTasks(done), "second")[0]).toMatchObject({ folder: "/original", doneAt: 3 });
    const deleted = deleteTask(done, "a", 4);
    expect(linkTaskThreads(deleted, "a", ["third"], 5)).toBe(deleted);
    expect(unlinkTaskThread(deleted, "a", "second", 5)).toBe(deleted);
    expect(linkedTasks(listTasks(deleted), "second")).toEqual([]);
  });

  it("filters open and completed tasks by the full project path or no project", () => {
    const a = addTask({}, "Unassigned", 1, "a");
    const both = addTask(a, { title: "Same name", folder: "/second/app" }, 2, "b");
    const third = addTask(both, { title: "Different project", folder: "/first/app" }, 3, "c");
    const tasks = listTasks(tickTask(third, "b", true, 4));
    expect(tasksInProject(tasks, undefined)).toEqual(tasks);
    expect(tasksInProject(tasks, null).map(({ id }) => id)).toEqual(["a"]);
    expect(splitTasks(tasksInProject(tasks, "/second/app")).done.map(({ id }) => id)).toEqual(["b"]);
    expect(tasksInProject(tasks, "/missing")).toEqual([]);
  });
});

describe("task capture", () => {
  it("uses the first line as the message's title and stores the conversation and project", () => {
    expect(taskFromMessage("  Fix login\r\nDetails to follow.  ", "thread", "/project")).toEqual({
      title: "Fix login",
      note: "Fix login\r\nDetails to follow.",
      folder: "/project",
      threadIds: ["thread"],
    });
    const long = taskFromMessage("x".repeat(MAX_TASK_NOTE + 30), "chat");
    expect(long.title).toHaveLength(MAX_TASK_TITLE);
    expect(long.note).toHaveLength(MAX_TASK_NOTE);
    expect(long.folder).toBeUndefined();
  });

  it("keeps the issue number, URL, description, and project", () => {
    const issue = {
      number: 42,
      title: "Reduce startup time",
      url: "https://github.com/org/repo/issues/42",
      body: "Details",
    };
    expect(taskFromIssue(issue, "/project")).toEqual({
      title: "#42 Reduce startup time",
      note: `${issue.url}\n\nDetails`,
      folder: "/project",
    });
    expect(taskFromIssue({ ...issue, body: " " }, "/project").note).toBe(issue.url);
  });

  it("keeps escape-heavy captures small enough to sync", () => {
    const captured = taskFromMessage('"'.repeat(MAX_TASK_NOTE), "thread", "/project");
    const task = addTask({}, captured, Date.now(), "a");
    expect(captured.note!.length).toBeLessThan(MAX_TASK_NOTE);
    expect(reconcileTasks(task, []).send).toEqual([task["a"]]);
  });
});

describe("offering to complete linked tasks", () => {
  const input = { _tag: "TurnInput", items: [{ _tag: "FromUser", text: "Do the task" }] } as const;
  const completed = { _tag: "TurnCompleted", stopReason: "completed" } as const;
  const events = (...payloads: ReadonlyArray<EventPayload>): ReadonlyArray<AgentEvent> =>
    payloads.map((payload, sequence) => ({
      agentId: "lead" as AgentId,
      threadId: "thread" as ThreadId,
      id: `event-${sequence}` as EventId,
      sequence,
      at: sequence,
      payload,
    }));

  it("requires the lead's latest turn to have completed successfully", () => {
    expect(leadFinished([], "lead")).toBe(false);
    expect(leadFinished(events(input, completed), "lead")).toBe(true);
    expect(leadFinished(events(input, completed), "child")).toBe(false);
    expect(leadFinished(events(input, completed, input), "lead")).toBe(false);
    for (const stopReason of ["interrupted", "error", "maxTurns", "steered"] as const) {
      expect(leadFinished(events(input, completed, input, { ...completed, stopReason }), "lead")).toBe(false);
    }
  });
});

describe("syncing the user's tasks", () => {
  it("takes the account's newer edits and sends this window's", () => {
    const local = {
      a: { id: "a", updatedAt: 5, task: { title: "mine", createdAt: 1 } },
      b: { id: "b", updatedAt: 2, task: { title: "old here", createdAt: 1 } },
      c: { id: "c", updatedAt: 3, task: { title: "only here", createdAt: 1 } },
    };
    const cloud = [
      { id: "a", updatedAt: 4, task: { title: "old there", createdAt: 1 } },
      { id: "b", updatedAt: 6, task: { title: "theirs", createdAt: 1 } },
      { id: "d", updatedAt: 7 },
    ];
    const { take, send } = reconcileTasks(local, cloud);
    expect(take.map((entry) => entry.id)).toEqual(["b", "d"]);
    expect(send.map((entry) => entry.id)).toEqual(["a", "c"]);
    const after = applyTaken(local, take);
    expect(listTasks(after).map((task) => task.title)).toEqual(["mine", "theirs", "only here"]);
    expect(reconcileTasks(after, [...cloud, ...send])).toEqual({ take: [], send: [] });
  });

  it("doesn't tell the account of a task deleted before it was ever shared", () => {
    const local = deleteTask(addTask({}, "task", 1, "a"), "a", 2);
    expect(reconcileTasks(local, []).send).toEqual([]);
    expect(reconcileTasks(local, [{ id: "a", updatedAt: 1, task: {} }]).send).toEqual([
      { id: "a", updatedAt: 2 },
    ]);
  });
});
