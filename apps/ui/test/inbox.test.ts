import { describe, expect, it } from "@effect/vitest";

import {
  entryThreads,
  groupRuns,
  nextWaitingThread,
  sameSummary,
  type ThreadSummary,
} from "../src/features/threads/model.ts";
import { inboxFocusAfterRemoval, inboxNavigationTarget } from "../src/features/threads/inboxNavigation.ts";
import { wordmark } from "../src/features/threads/ProjectBadge.tsx";
import { isUnread } from "../src/features/threads/readState.ts";
import {
  chatSections,
  filterInboxEntries,
  firstOf,
  inboxProjects,
  inboxSections,
} from "../src/features/threads/sections.ts";

const now = new Date(2026, 9, 18, 15, 0).getTime();
const HOUR = 3_600_000;

const thread = (id: string, overrides: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id,
  title: id,
  mode: "work",
  project: "cerium",
  folder: "C:/code/cerium",
  status: "idle",
  providers: ["claude"],
  unread: false,
  updatedAt: now - HOUR,
  ...overrides,
});

const layout = (sections: ReturnType<typeof inboxSections>) =>
  sections.map(({ label, threads }) => [label, threads.map(({ id }) => id)]);

describe("nextWaitingThread", () => {
  it("prioritizes approvals and unread failures across both modes and wraps", () => {
    const threads = [
      thread("unread", { unread: true, updatedAt: now + 1 }),
      thread("failed", { status: "failed", unread: true, updatedAt: now - 1 }),
      thread("approval", { status: "awaitingApproval", mode: "chat", updatedAt: now }),
      thread("other-approval", { status: "awaitingApproval", updatedAt: now - 2 }),
    ];
    expect(nextWaitingThread(threads, "unread")?.id).toBe("approval");
    expect(nextWaitingThread(threads, "approval")?.id).toBe("failed");
    expect(nextWaitingThread(threads, "failed")?.id).toBe("other-approval");
    expect(nextWaitingThread(threads, "other-approval")?.id).toBe("approval");
  });

  it("falls back to unread threads and skips archived threads and seen failures", () => {
    const threads = [
      thread("archived", { unread: true, archivedAt: now }),
      thread("failed", { status: "failed", updatedAt: now }),
      thread("beta", { unread: true }),
      thread("alpha", { unread: true }),
    ];
    expect(nextWaitingThread(threads, undefined)?.id).toBe("alpha");
    expect(nextWaitingThread(threads, "alpha")?.id).toBe("beta");
    expect(nextWaitingThread(threads, "beta")?.id).toBe("alpha");
    expect(nextWaitingThread(threads.slice(0, 2), undefined)).toBeUndefined();
  });

  it("skips the current thread when it is the sole waiting match", () => {
    const waiting = thread("waiting", { status: "awaitingApproval", archivedAt: now });
    expect(nextWaitingThread([waiting], undefined)?.id).toBe("waiting");
    expect(nextWaitingThread([waiting], "waiting")).toBeUndefined();
    expect(nextWaitingThread([waiting, thread("unread", { unread: true })], "waiting")?.id).toBe("unread");
  });
});

describe("inboxSections", () => {
  it("puts what needs the user first, then work in progress, then unread, then history", () => {
    const sections = inboxSections(
      [
        thread("old", { updatedAt: now - 30 * HOUR }),
        thread("finished", { unread: true }),
        thread("running", { status: "running" }),
        thread("approval", { status: "awaitingApproval" }),
        thread("today"),
      ],
      now,
    );
    expect(layout(sections)).toEqual([
      ["Needs you", ["approval"]],
      ["Working", ["running"]],
      ["Unread", ["finished"]],
      ["Today", ["today"]],
      ["Yesterday", ["old"]],
    ]);
  });

  it("asks about a failure until the user has seen it", () => {
    const sections = inboxSections(
      [thread("unseen", { status: "failed", unread: true }), thread("seen", { status: "failed" })],
      now,
    );
    expect(layout(sections)).toEqual([
      ["Needs you", ["unseen"]],
      ["Today", ["seen"]],
    ]);
  });

  it("lists newest first within a section", () => {
    const sections = inboxSections(
      [
        thread("a", { status: "running", updatedAt: now - 3 * HOUR }),
        thread("b", { status: "running", updatedAt: now - HOUR }),
      ],
      now,
    );
    expect(layout(sections)).toEqual([["Working", ["b", "a"]]]);
  });
});

describe("chatSections", () => {
  it("groups by recency only, whatever the chat is doing", () => {
    const sections = chatSections(
      [
        thread("waiting", { mode: "chat", status: "awaitingApproval" }),
        thread("older", { mode: "chat", updatedAt: now - 20 * 24 * HOUR }),
      ],
      now,
    );
    expect(layout(sections)).toEqual([
      ["Today", ["waiting"]],
      ["Older", ["older"]],
    ]);
  });
});

describe("Inbox status filters", () => {
  const threads = [
    thread("read"),
    thread("approval", { status: "awaitingApproval" }),
    thread("unseen-failure", { status: "failed", unread: true }),
    thread("seen-failure", { status: "failed" }),
    thread("working-unread", { status: "running", unread: true }),
    thread("first", { runId: "comparison" }),
    thread("worktree", { runId: "comparison", worktree: { branch: "patch", base: "main" } }),
    thread("other-project", { folder: "/other", worktree: { branch: "patch", base: "main" } }),
  ];
  const entries = groupRuns(threads.filter((thread) => thread.folder === "C:/code/cerium"));
  const ids = (status: Parameters<typeof filterInboxEntries>[1]) =>
    filterInboxEntries(entries, status)
      .flatMap(entryThreads)
      .map(({ id }) => id);

  it("matches approvals, unread failures, active work, and unread cards independently", () => {
    expect(ids("all")).toHaveLength(7);
    expect(ids("needsYou")).toEqual(["approval", "unseen-failure"]);
    expect(ids("working")).toEqual(["working-unread"]);
    expect(ids("unread")).toEqual(["unseen-failure", "working-unread"]);
  });

  it("keeps a matching comparison together within the project scope", () => {
    expect(ids("worktree")).toEqual(["first", "worktree"]);
    expect(filterInboxEntries(entries, "worktree")).toHaveLength(1);
    expect(filterInboxEntries(groupRuns([thread("read")]), "worktree")).toEqual([]);
  });
});

describe("Inbox keyboard navigation", () => {
  const cards = ["first", "comparison", "last"];
  it("moves through cards with J/K and the arrows, stopping at the ends", () => {
    expect(inboxNavigationTarget(cards, "first", "j")).toBe("comparison");
    expect(inboxNavigationTarget(cards, "comparison", "ArrowDown")).toBe("last");
    expect(inboxNavigationTarget(cards, "last", "J")).toBe("last");
    expect(inboxNavigationTarget(cards, "last", "k")).toBe("comparison");
    expect(inboxNavigationTarget(cards, "comparison", "ArrowUp")).toBe("first");
    expect(inboxNavigationTarget(cards, "first", "ArrowUp")).toBe("first");
    expect(inboxNavigationTarget(cards, "first", "h")).toBeUndefined();
  });

  it("enters from the panel in either direction and jumps across the whole list", () => {
    expect(inboxNavigationTarget(cards, undefined, "ArrowDown")).toBe("first");
    expect(inboxNavigationTarget(cards, undefined, "ArrowUp")).toBe("last");
    expect(inboxNavigationTarget(cards, "last", "Home")).toBe("first");
    expect(inboxNavigationTarget(cards, "first", "End")).toBe("last");
    expect(inboxNavigationTarget([], undefined, "ArrowDown")).toBeUndefined();
  });

  it("continues triage at the next surviving card or falls back to the previous card", () => {
    const afterArchive = ["last", "first"];
    const next = inboxFocusAfterRemoval(cards, afterArchive, "comparison");
    expect(next).toBe("last");
    expect(inboxFocusAfterRemoval(afterArchive, ["first"], next!)).toBe("first");
    expect(inboxFocusAfterRemoval(cards, ["first"], "last")).toBe("first");
    expect(inboxFocusAfterRemoval(["first"], [], "first")).toBeUndefined();
  });
});

describe("firstOf", () => {
  const sections = chatSections(
    [
      thread("a", { mode: "chat", updatedAt: now - HOUR }),
      thread("b", { mode: "chat", updatedAt: now - 2 * HOUR }),
      thread("c", { mode: "chat", updatedAt: now - 30 * HOUR }),
      thread("d", { mode: "chat", updatedAt: now - 31 * HOUR }),
    ],
    now,
  );

  it("counts the threads across the sections in order, dropping the sections past them", () => {
    expect(layout(firstOf(sections, 3))).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
    ]);
    expect(layout(firstOf(sections, 2))).toEqual([["Today", ["a", "b"]]]);
  });
});

describe("inboxProjects", () => {
  it("lists each folder once, most recently active first, keeping same-named folders apart", () => {
    const projects = inboxProjects([
      thread("a", { folder: "C:/code/cerium", updatedAt: now - 3 * HOUR }),
      thread("b", { folder: "D:/fork/cerium", updatedAt: now - HOUR }),
      thread("c", { folder: "C:/code/cerium", updatedAt: now - 2 * HOUR }),
    ]);
    expect(projects.map(({ folder }) => folder)).toEqual(["D:/fork/cerium", "C:/code/cerium"]);
  });
});

describe("wordmark", () => {
  it("takes the initials of a project's first two words, or a single word's first two letters", () => {
    expect(wordmark("roblox-suite")).toBe("RS");
    expect(wordmark("myApp")).toBe("MA");
    expect(wordmark("cerium")).toBe("Ce");
    expect(wordmark(".dotfiles")).toBe("Do");
  });
});

describe("sameSummary", () => {
  it("finds summaries built afresh from the same thread the same", () => {
    const built = () =>
      thread("a", {
        providers: ["claude", "codex"],
        worktree: { branch: "fix", base: "main" },
        lead: { id: "agt_1", model: "claude-opus-5-5" },
      });
    expect(sameSummary(built(), built())).toBe(true);
  });

  it("tells apart summaries that show something different", () => {
    const base = thread("a", { providers: ["claude"], lead: { id: "agt_1", model: "claude-opus-5-5" } });
    expect(sameSummary(base, { ...base, unread: true })).toBe(false);
    expect(sameSummary(base, { ...base, providers: ["claude", "codex"] })).toBe(false);
    expect(sameSummary(base, { ...base, lead: { id: "agt_1", model: "claude-sonnet-5-5" } })).toBe(false);
    expect(sameSummary(base, { ...base, laterUntil: now })).toBe(false);
  });
});

describe("isUnread", () => {
  const state = { since: now - 10 * HOUR, seen: { opened: now - 2 * HOUR, flagged: 0 } };

  it("treats history from before tracking started as read", () => {
    expect(isUnread(state, "untracked", now - 11 * HOUR)).toBe(false);
    expect(isUnread(state, "untracked", now - 9 * HOUR)).toBe(true);
  });

  it("is unread once a thread changed after the user saw it, or when they marked it", () => {
    expect(isUnread(state, "opened", now - 2 * HOUR)).toBe(false);
    expect(isUnread(state, "opened", now - HOUR)).toBe(true);
    expect(isUnread(state, "flagged", now - 20 * HOUR)).toBe(true);
  });
});
