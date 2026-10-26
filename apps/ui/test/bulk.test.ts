import { describe, expect, it } from "@effect/vitest";

import { planBulk, rangeSelected, summarizeBulk, toggleSelected } from "../src/features/threads/bulk.ts";
import type { ThreadSummary } from "../src/features/threads/model.ts";

const thread = (id: string, overrides: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id,
  title: id,
  mode: "work",
  status: "idle",
  providers: ["claude"],
  unread: false,
  updatedAt: 0,
  ...overrides,
});

const byId = (threads: ReadonlyArray<ThreadSummary>) =>
  new Map(threads.map((candidate) => [candidate.id, candidate]));

describe("toggleSelected", () => {
  it("adds a thread and drops it again", () => {
    expect(toggleSelected([], "a")).toEqual(["a"]);
    expect(toggleSelected(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("rangeSelected", () => {
  const ordered = ["a", "b", "c", "d"];

  it("takes the run from the anchor to the thread, keeping the rest", () => {
    expect(rangeSelected(ordered, ["a"], "b", "d")).toEqual(["a", "b", "c", "d"]);
    expect(rangeSelected(ordered, [], "d", "b")).toEqual(["b", "c", "d"]);
  });

  it("takes only the thread without an anchor, and nothing unknown", () => {
    expect(rangeSelected(ordered, ["a"], undefined, "c")).toEqual(["a", "c"]);
    expect(rangeSelected(ordered, ["a"], "b", "gone")).toEqual(["a"]);
  });
});

describe("planBulk", () => {
  const idle = thread("idle");
  const running = thread("running", { status: "running" });
  const waiting = thread("waiting", { status: "awaitingApproval" });
  const away = thread("away", { elsewhere: { machine: "m2", online: true }, machine: "Laptop" });
  const threads = byId([idle, running, waiting, away]);
  const ids = ["idle", "running", "waiting", "away"];

  it("archives and deletes only quiet threads here, saying which it skipped and why", () => {
    for (const action of ["archive", "later", "delete"] as const) {
      const plan = planBulk(threads, ids, action);
      expect(plan.act.map(({ id }) => id)).toEqual(["idle"]);
      expect(plan.skipped).toEqual([
        { id: "running", title: "running", reason: "its agents are still working" },
        { id: "waiting", title: "waiting", reason: "it's waiting on you" },
        { id: "away", title: "away", reason: "it's on Laptop" },
      ]);
    }
  });

  it("brings back every thread here, whatever its agents do", () => {
    const plan = planBulk(threads, ["running", "away"], "restore");
    expect(plan.act.map(({ id }) => id)).toEqual(["running"]);
    expect(plan.skipped).toEqual([{ id: "away", title: "away", reason: "it's on Laptop" }]);
  });

  it("pins and marks read everywhere, including another machine's threads", () => {
    for (const action of ["pin", "unpin", "read"] as const) {
      expect(planBulk(threads, ids, action).act.map(({ id }) => id)).toEqual(ids);
      expect(planBulk(threads, ids, action).skipped).toEqual([]);
    }
  });

  it("drops ids the lists don't know", () => {
    expect(planBulk(threads, ["idle", "gone"], "archive").act.map(({ id }) => id)).toEqual(["idle"]);
  });
});

describe("summarizeBulk", () => {
  const idle = thread("idle");
  const running = thread("running", { status: "running" });

  it("names what it did and which threads it skipped with why", () => {
    const plan = planBulk(byId([idle, running]), ["idle", "running"], "archive");
    expect(summarizeBulk("archive", plan)).toBe(
      "Archived 1 · 1 skipped: “running” (its agents are still working)",
    );
  });

  it("says only what it did when nothing was skipped", () => {
    expect(summarizeBulk("read", planBulk(byId([idle]), ["idle"], "read"))).toBe("Marked as read 1");
  });

  it("says nothing changed when every thread was skipped", () => {
    const plan = planBulk(byId([running]), ["running"], "delete");
    expect(summarizeBulk("delete", plan)).toBe(
      "Nothing changed · 1 skipped: “running” (its agents are still working)",
    );
  });
});
