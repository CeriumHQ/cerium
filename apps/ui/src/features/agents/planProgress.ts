import type { TodoItem } from "@cerium/protocol";

/** Where an agent's plan stands, for the line shown while the list is folded. */
export interface PlanProgress {
  readonly total: number;
  readonly completed: number;
  /** Items dropped without being finished. */
  readonly cancelled: number;
  /** Nothing is left to do: every item is completed or cancelled. */
  readonly finished: boolean;
  /** The item in progress, else the next one waiting; absent once the plan is finished. */
  readonly current?: TodoItem;
  /** The current item is being worked on now, not just next in line. */
  readonly active: boolean;
}

export const planProgress = (items: ReadonlyArray<TodoItem>): PlanProgress => {
  const completed = items.filter((item) => item.status === "completed").length;
  const cancelled = items.filter((item) => item.status === "cancelled").length;
  const working = items.find((item) => item.status === "inProgress");
  const next = working ?? items.find((item) => item.status === "pending");
  return {
    total: items.length,
    completed,
    cancelled,
    finished: items.length > 0 && completed + cancelled === items.length,
    ...(next ? { current: next } : {}),
    active: working !== undefined,
  };
};
