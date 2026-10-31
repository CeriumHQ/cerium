import type { AgentEvent, EventPayload } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { groupRuns, overflow, runSummary, type ThreadSummary } from "../src/features/threads/model.ts";
import { runStats } from "../src/features/threads/runs.ts";

const now = new Date(2026, 9, 24, 15, 0).getTime();
const HOUR = 3_600_000;
const thread = (id: string, patch: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id,
  title: id,
  mode: "work",
  folder: "C:/code/cerium",
  project: "cerium",
  status: "idle",
  providers: ["claude"],
  unread: false,
  updatedAt: now - HOUR,
  ...patch,
});

let sequence = 0;
const event = (agentId: string, at: number, payload: EventPayload): AgentEvent =>
  ({ id: `evt_${sequence}`, threadId: "thr_a", agentId, sequence: sequence++, at, payload }) as AgentEvent;

const changed = (
  turnId: string,
  files: ReadonlyArray<[path: string, added: number, removed: number]>,
): EventPayload => {
  const [first, ...rest] = files.map(([path, added, removed]) => ({
    path,
    change: "modified" as const,
    added,
    removed,
    via: "edit" as const,
  }));
  return { _tag: "TurnFilesChanged", turnId, before: "a", after: "b", files: [first!, ...rest] };
};

describe("Multi-agent runs", () => {
  it("shows a run's threads together where the first of them is, in the order they started", () => {
    const entries = groupRuns([
      thread("b", { runId: "r", createdAt: 2 }),
      thread("solo"),
      thread("a", { runId: "r", createdAt: 1 }),
      thread("alone", { runId: "s" }),
    ]);
    expect(
      entries.map((entry) => (entry.kind === "thread" ? entry.thread.id : entry.threads.map((t) => t.id))),
    ).toEqual([["a", "b"], "solo", "alone"]);
  });

  it("sums a run up by what asks most of the user", () => {
    const run = runSummary([
      thread("a", { status: "running", providers: ["claude", "codex"], updatedAt: 5 }),
      thread("b", { status: "awaitingApproval", providers: ["codex"], unread: true, updatedAt: 9 }),
      thread("c", { providers: ["cursor"], updatedAt: 1 }),
    ]);
    expect(run).toMatchObject({
      id: "a",
      status: "awaitingApproval",
      unread: true,
      updatedAt: 9,
      providers: ["claude", "codex", "cursor"],
    });
  });

  it("counts a run as one card against the inbox's cap, and lets it go only whole", () => {
    const old = (id: string, hours: number, patch: Partial<ThreadSummary> = {}) =>
      thread(id, { updatedAt: now - hours * HOUR, ...patch });
    const inbox = [
      old("r1", 9, { runId: "r" }),
      old("r2", 9, { runId: "r" }),
      old("r3", 9, { runId: "r" }),
      old("x", 8),
      old("y", 1),
    ];
    expect(overflow(inbox, () => false, now, 3)).toEqual([]);
    expect(overflow(inbox, () => false, now, 2).map((t) => t.id)).toEqual(["r1", "r2", "r3"]);
    // One thread still working keeps the whole run.
    const working = inbox.map((t) => (t.id === "r2" ? { ...t, status: "running" as const } : t));
    expect(overflow(working, () => false, now, 2).map((t) => t.id)).toEqual(["x"]);
  });

  it("works out what a thread changed, less what was undone, and how long its lead took", () => {
    const events = [
      event(
        "lead",
        1_000,
        changed("t1", [
          ["a.ts", 10, 2],
          ["b.ts", 3, 0],
        ]),
      ),
      event("child", 2_000, { _tag: "TurnCompleted", stopReason: "completed" } as EventPayload),
      event("lead", 61_000, { _tag: "TurnCompleted", stopReason: "completed" } as EventPayload),
      event("lead", 62_000, changed("t2", [["a.ts", 5, 5]])),
      event("lead", 63_000, changed("t3", [["c.ts", 100, 0]])),
      event("lead", 64_000, {
        _tag: "TurnFilesReverted",
        turnId: "t3",
        direction: "undone",
        paths: ["c.ts"],
        kept: [],
      } as EventPayload),
      event("lead", 90_000, { _tag: "TurnCompleted", stopReason: "completed" } as EventPayload),
    ];
    expect(runStats(events, "lead", 0)).toEqual({ added: 18, removed: 7, files: 2, took: 61_000 });
    expect(runStats(events.slice(0, 2), "lead", 0)).toEqual({ added: 13, removed: 2, files: 2 });
  });
});
