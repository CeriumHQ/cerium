import type { AgentEvent, EventPayload } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import {
  closeKeys,
  focusPane,
  focusedKey,
  leavesOf,
  singlePane,
  spreadBeside,
} from "../src/features/split/model.ts";
import { closeTabs } from "../src/features/tabs/model.ts";
import { groupRuns, overflow, runSummary, type ThreadSummary } from "../src/features/threads/model.ts";
import { archiveRunSiblings, planKeepRun, runStats } from "../src/features/threads/runs.ts";

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
    const undoB = event("lead", 91_000, {
      _tag: "TurnFilesReverted",
      turnId: "t1",
      direction: "undone",
      paths: ["b.ts"],
      kept: ["a.ts"],
      partial: true,
    });
    expect(runStats([...events, undoB], "lead", 0)).toEqual({
      added: 15,
      removed: 7,
      files: 1,
      took: 61_000,
    });
  });

  it("adds reported USD, input, cached input, and output across the thread's agents and turns", () => {
    const usage = [
      event("lead", 1_000, {
        _tag: "UsageReported",
        inputTokens: 100,
        cachedInputTokens: 50,
        outputTokens: 12,
        costUsd: 0.25,
      }),
      event("child", 2_000, { _tag: "UsageReported", inputTokens: 30, outputTokens: 8 }),
      event("lead", 3_000, { _tag: "UsageReported", inputTokens: 1, outputTokens: 2, costUsd: 0.125 }),
    ];
    expect(runStats(usage, "lead", 0)).toEqual({
      added: 0,
      removed: 0,
      files: 0,
      tokens: 203,
      costUsd: 0.375,
    });
    expect(runStats(usage.slice(1, 2), "lead", 0)).toEqual({ added: 0, removed: 0, files: 0, tokens: 38 });
  });

  it("keeps a reported zero cost and leaves unreported usage absent", () => {
    expect(
      runStats(
        [event("lead", 1, { _tag: "UsageReported", inputTokens: 0, outputTokens: 0, costUsd: 0 })],
        "lead",
        0,
      ),
    ).toMatchObject({ costUsd: 0, tokens: 0 });
    expect(
      runStats(
        [event("lead", 1, { _tag: "UsageReported", inputTokens: 0, outputTokens: 0, unreported: true })],
        "lead",
        0,
      ),
    ).toEqual({ added: 0, removed: 0, files: 0 });
  });
});

describe("Keep this one", () => {
  const winner = thread("keep", { status: "running" });
  const closed = thread("already archived", { archivedAt: now });
  const clean = thread("clean");
  const running = thread("running", { status: "running" });
  const approval = thread("approval", { status: "awaitingApproval" });
  const remote = thread("remote", { elsewhere: { machine: "remote", online: true } });
  const changed = thread("changed", { worktree: { branch: "w", base: "main" } });

  it("offers to archive eligible siblings while retaining the winner and reporting blocked siblings", () => {
    const plan = planKeepRun([winner, clean, running, approval, remote, closed], winner.id);
    expect(plan.act).toEqual([clean]);
    expect(plan.skipped).toEqual([
      { id: "running", title: "running", reason: "its agents are still working" },
      { id: "approval", title: "approval", reason: "it's waiting on you" },
      { id: "remote", title: "remote", reason: "it's on another machine" },
    ]);
    expect(planKeepRun([winner, running, approval, remote], winner.id).act).toEqual([]);
    expect(planKeepRun([winner], winner.id).act).toEqual([]);
    expect(planKeepRun([remote, clean], remote.id).act).toEqual([]);
    expect(planKeepRun([closed, clean], closed.id).act).toEqual([]);
    expect(planKeepRun([clean], "missing").act).toEqual([]);
  });

  it("returns only successful sibling IDs for tab closure and reports dirty or failed archives", async () => {
    const failed = thread("failed");
    const tried: Array<string> = [];
    const result = await archiveRunSiblings(
      planKeepRun([winner, running, changed, failed, clean], winner.id),
      async (id) => {
        tried.push(id);
        if (id === changed.id) return "its worktree has uncommitted or unmerged changes";
        if (id === failed.id) throw new Error("Archive unavailable");
        return undefined;
      },
    );
    expect(tried).toEqual([changed.id, failed.id, clean.id]);
    expect(result.act).toEqual([clean]);
    expect(result.skipped.map(({ id, reason }) => [id, reason])).toEqual([
      [running.id, "its agents are still working"],
      [changed.id, "its worktree has uncommitted or unmerged changes"],
      [failed.id, "the archive failed"],
    ]);
  });

  it("keeps the winner focused while successful sibling tabs and panes close", async () => {
    const unrelated = "unrelated";
    const result = await archiveRunSiblings(planKeepRun([winner, changed, clean], winner.id), async (id) =>
      id === changed.id ? "its worktree has uncommitted changes" : undefined,
    );
    const archived = result.act.map(({ id }) => id);
    const keys = [winner.id, changed.id, clean.id, unrelated];
    const tabs = closeTabs({ keys, active: winner.id, closed: [] }, archived, { remember: false }).strip;
    expect(tabs.keys).toEqual([winner.id, changed.id, unrelated]);
    expect(tabs.active).toBe(winner.id);
    const split = spreadBeside(
      singlePane("winner-pane", winner.id),
      "winner-pane",
      keys.slice(1).map((key) => ({ key, id: key })),
    );
    const panes = closeKeys(focusPane(split, "winner-pane"), archived)!;
    expect(leavesOf(panes.root).map(({ key }) => key)).toEqual(tabs.keys);
    expect(focusedKey(panes)).toBe(winner.id);
  });
});
