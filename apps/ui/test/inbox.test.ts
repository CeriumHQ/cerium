import { describe, expect, it } from "@effect/vitest";

import { sameSummary, type ThreadSummary } from "../src/features/threads/model.ts";
import { wordmark } from "../src/features/threads/ProjectBadge.tsx";
import { isUnread } from "../src/features/threads/readState.ts";
import { chatSections, firstOf, inboxProjects, inboxSections } from "../src/features/threads/sections.ts";

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

  it("keeps a section it takes whole as it was", () => {
    expect(firstOf(sections, 10)[0]).toBe(sections[0]);
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
