import type { TodoItem } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { planProgress } from "../src/features/agents/planProgress.ts";

const list = (...statuses: ReadonlyArray<TodoItem["status"]>): ReadonlyArray<TodoItem> =>
  statuses.map((status, index) => ({ text: `Step ${index + 1}`, status }));

describe("planProgress", () => {
  it("counts finished items and finds the one being worked on", () => {
    const progress = planProgress([
      { text: "Write", status: "completed" },
      { text: "Test", status: "inProgress", activeText: "Running the tests" },
      { text: "Ship", status: "pending" },
    ]);
    expect(progress).toMatchObject({ total: 3, completed: 1, cancelled: 0, finished: false, active: true });
    expect(progress.current?.text).toBe("Test");
  });

  it("names the next item when nothing is in progress yet", () => {
    const progress = planProgress(list("completed", "pending", "pending"));
    expect(progress.active).toBe(false);
    expect(progress.current?.text).toBe("Step 2");
  });

  it("is finished once every item is completed or dropped", () => {
    const progress = planProgress(list("completed", "cancelled"));
    expect(progress).toMatchObject({ finished: true, completed: 1, cancelled: 1 });
    expect(progress.current).toBeUndefined();
  });

  it("is never finished for an empty list", () => {
    expect(planProgress([]).finished).toBe(false);
  });
});
