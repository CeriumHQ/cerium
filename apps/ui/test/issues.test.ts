import type { IssueDetail } from "@cerium/rpc";
import { describe, expect, it } from "@effect/vitest";

import {
  canTriage,
  filterCount,
  filtersKey,
  filtersOfKey,
  isFiltered,
  issueBrief,
  toggleLabel,
  withMilestone,
} from "../src/features/issues/model.ts";

const label = (name: string) => ({ name, color: "d73a4a" });

const issue = (patch: Partial<IssueDetail> = {}): IssueDetail => ({
  number: 42,
  title: "Crash on startup",
  state: "open",
  url: "https://github.com/acme/app/issues/42",
  author: { login: "ada" },
  createdAt: 1_000,
  updatedAt: 2_000,
  comments: 0,
  labels: [],
  assignees: [],
  pullRequests: [],
  id: "I_1",
  body: "It crashes.",
  locked: false,
  reactions: [],
  branches: [],
  canUpdate: true,
  timeline: [],
  revision: "r1",
  ...patch,
});

const comment = (id: string, login: string, body: string) => ({
  _tag: "Comment" as const,
  id,
  author: { login },
  body,
  at: 3_000,
  reactions: [],
});

describe("issue filters", () => {
  it("keys filters that ask the same thing alike, whatever order or spelling", () => {
    expect(filtersKey({})).toBe(filtersKey({ state: "open" }));
    expect(filtersKey({ search: "  crash " })).toBe(filtersKey({ search: "crash" }));
    expect(filtersKey({ search: "   " })).toBe(filtersKey({}));
    expect(filtersKey({ labels: ["bug", "ui", "bug"] })).toBe(filtersKey({ labels: ["ui", "bug"] }));
    expect(filtersKey({ state: "closed" })).not.toBe(filtersKey({}));
  });

  it("round trips through its key", () => {
    const filters = {
      state: "all",
      assignedToMe: true,
      labels: ["bug"],
      milestone: "v2",
      search: "x",
    } as const;
    expect(filtersOfKey(filtersKey(filters))).toEqual(filters);
  });

  it("counts what narrows the list, not the search or the default state", () => {
    expect(filterCount({})).toBe(0);
    expect(filterCount({ state: "open", search: "x" })).toBe(0);
    expect(filterCount({ state: "closed" })).toBe(1);
    expect(filterCount({ assignedToMe: true, createdByMe: true, mentioningMe: true })).toBe(3);
    expect(filterCount({ labels: ["a", "b", "a"] })).toBe(2);
    expect(filterCount({ milestone: "v2" })).toBe(1);
    expect(filterCount({ noMilestone: true })).toBe(1);
  });

  it("calls a list filtered when anything narrows it, search included", () => {
    expect(isFiltered({})).toBe(false);
    expect(isFiltered({ search: " " })).toBe(false);
    expect(isFiltered({ search: "crash" })).toBe(true);
    expect(isFiltered({ labels: ["bug"] })).toBe(true);
  });

  it("toggles a label on and off, dropping the list when it empties", () => {
    const on = toggleLabel({ state: "all" }, "bug");
    expect(on).toEqual({ state: "all", labels: ["bug"] });
    expect(toggleLabel(on, "ui").labels).toEqual(["bug", "ui"]);
    expect(toggleLabel(on, "bug")).toEqual({ state: "all" });
  });

  it("chooses a milestone, or none, in place of the one before", () => {
    expect(withMilestone({}, "v2")).toEqual({ milestone: "v2" });
    expect(withMilestone({ milestone: "v2" }, "none")).toEqual({ noMilestone: true });
    expect(withMilestone({ noMilestone: true }, "v3")).toEqual({ milestone: "v3" });
    expect(withMilestone({ milestone: "v2", search: "x" }, undefined)).toEqual({ search: "x" });
  });
});

describe("state", () => {
  it("lets triage and up change labels and assignees", () => {
    expect(canTriage(undefined)).toBe(false);
    expect(canTriage("none")).toBe(false);
    expect(canTriage("read")).toBe(false);
    expect(canTriage("triage")).toBe(true);
    expect(canTriage("write")).toBe(true);
    expect(canTriage("admin")).toBe(true);
  });
});

describe("the brief a thread starts from", () => {
  it("names the issue, its state and who is involved, then asks without changing anything", () => {
    const brief = issueBrief(
      issue({
        labels: [label("bug"), label("crash")],
        assignees: [{ login: "grace" }],
        milestone: "v2",
        pullRequests: [{ number: 7, state: "open", url: "u" }],
      }),
    );
    expect(brief).toContain('GitHub issue #42, "Crash on startup" (https://github.com/acme/app/issues/42)');
    expect(brief).toContain("Open; labels: bug, crash; assigned to grace; milestone: v2");
    expect(brief).toContain("linked pull requests: #7 (open)");
    expect(brief).toContain("Opened by ada");
    expect(brief).toContain("Description:\nIt crashes.");
    expect(brief).toMatch(/Don't change anything yet\.$/);
  });

  it("says so when the issue has no description, and how a closed one closed", () => {
    const brief = issueBrief(issue({ body: "  ", state: "closed", stateReason: "notPlanned" }));
    expect(brief).toContain("It has no description.");
    expect(brief).toContain("Closed as not planned");
  });

  it("quotes the comments in order and leaves out the hidden and the empty ones", () => {
    const brief = issueBrief(
      issue({
        timeline: [
          comment("1", "grace", "I can reproduce."),
          { ...comment("2", "troll", "spam"), hidden: "Spam" },
          comment("3", "ada", "   "),
          comment("4", "linus", "Fixed in main."),
        ],
      }),
    );
    expect(brief).toContain("Comments, oldest first:");
    expect(brief.indexOf("grace wrote:")).toBeLessThan(brief.indexOf("linus wrote:"));
    expect(brief).not.toContain("spam");
    expect(brief).not.toContain("ada wrote:");
  });

  it("keeps a long history within its size and says what it left out", () => {
    const many = Array.from({ length: 40 }, (_, index) => comment(String(index), "ada", "x".repeat(3_900)));
    const brief = issueBrief(issue({ timeline: many }));
    expect(brief.length).toBeLessThan(26_000);
    expect(brief).toContain("More of the conversation is on GitHub than is quoted here.");
  });

  it("cuts one very long text and says how much", () => {
    const brief = issueBrief(issue({ body: "y".repeat(5_000) }));
    expect(brief).toContain("(cut: 1000 more characters on GitHub)");
  });

  it("notes a conversation the viewer only read the start of", () => {
    expect(issueBrief(issue({ more: true }))).toContain("More of the conversation is on GitHub");
    expect(issueBrief(issue())).not.toContain("More of the conversation");
  });
});
