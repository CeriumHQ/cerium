import { describe, expect, it } from "@effect/vitest";

import {
  addTask,
  applyTaken,
  deleteTask,
  editTask,
  listTasks,
  parseTasks,
  reconcileTasks,
  splitTasks,
  tickTask,
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
