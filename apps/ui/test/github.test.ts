import type { ConversationItem, PullRequestDetail, ReviewThread } from "@cerium/rpc";
import { describe, expect, it } from "@effect/vitest";

import {
  foldConversation,
  githubKey,
  githubOfKey,
  pullFilterCount,
  pullFiltersKey,
  pullFiltersOfKey,
  pullRequestBrief,
  pullStateOf,
  threadsByReview,
  titleOfBranch,
} from "../src/features/github/model.ts";

const pull = (patch: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
  number: 7,
  title: "Fix the login loop",
  state: "open",
  draft: false,
  url: "https://github.com/acme/app/pull/7",
  author: { login: "ada" },
  createdAt: 1_000,
  updatedAt: 2_000,
  head: "fix/login-loop",
  base: "main",
  labels: [],
  comments: 0,
  mergeable: "mergeable",
  additions: 12,
  deletions: 3,
  id: "PR_1",
  body: "Stops the redirect.",
  reactions: [],
  headOid: "abc123",
  headExists: true,
  assignees: [],
  reviewers: [],
  changedFiles: 2,
  commitCount: 1,
  canUpdate: true,
  mine: false,
  timeline: [],
  timelineTotal: 0,
  threads: [],
  revision: "r1",
  ...patch,
});

const thread = (patch: Partial<ReviewThread> = {}): ReviewThread => ({
  id: "T_1",
  path: "src/login.ts",
  side: "new",
  line: 14,
  resolved: false,
  outdated: false,
  canResolve: true,
  canReply: true,
  comments: [{ id: "C_1", author: { login: "grace" }, body: "Why here?", at: 1_500, reactions: [] }],
  ...patch,
});

const committed = (oid: string, at: number): ConversationItem => ({
  _tag: "Committed",
  at,
  oid,
  headline: `Commit ${oid}`,
  url: `https://github.com/acme/app/commit/${oid}`,
});

const comment = (id: string, body: string, patch: Partial<ConversationItem> = {}): ConversationItem =>
  ({
    _tag: "Comment",
    id,
    author: { login: "grace" },
    body,
    at: 1_200,
    reactions: [],
    ...patch,
  }) as ConversationItem;

describe("GitHub tab keys", () => {
  it("names a pull request or an issue and reads back", () => {
    const key = githubKey("C:\\work\\app", "pr", 7);
    expect(githubOfKey(key)).toEqual({ root: "C:\\work\\app", kind: "pr", number: 7 });
    expect(githubOfKey(githubKey("/home/ada/app", "issue", 42))).toEqual({
      root: "/home/ada/app",
      kind: "issue",
      number: 42,
    });
  });

  it("refuses keys that aren't a GitHub tab's", () => {
    expect(githubOfKey(undefined)).toBeUndefined();
    expect(githubOfKey("file:/app\nREADME.md")).toBeUndefined();
    expect(githubOfKey("github:/app\ncommit\n7")).toBeUndefined();
    expect(githubOfKey("github:/app\npr\n0")).toBeUndefined();
    expect(githubOfKey("github:/app\npr\n1.5")).toBeUndefined();
    expect(githubOfKey("github:\npr\n7")).toBeUndefined();
  });
});

describe("pull request filters", () => {
  it("keys filters that ask the same thing alike", () => {
    expect(pullFiltersKey({})).toBe(pullFiltersKey({ state: "open", search: "  " }));
    expect(pullFiltersKey({ createdByMe: false })).toBe(pullFiltersKey({}));
    expect(pullFiltersKey({ search: " login ", state: "merged" })).toBe(
      pullFiltersKey({ state: "merged", search: "login" }),
    );
  });

  it("reads the filters back from their key", () => {
    const filters = { state: "closed", reviewRequested: true, search: "login" } as const;
    expect(pullFiltersOfKey(pullFiltersKey(filters))).toEqual(filters);
  });

  it("counts what narrows the list, but not the search or showing open ones", () => {
    expect(pullFilterCount({})).toBe(0);
    expect(pullFilterCount({ state: "open", search: "login" })).toBe(0);
    expect(pullFilterCount({ state: "all", createdByMe: true, assignedToMe: true })).toBe(3);
  });
});

describe("how a pull request reads", () => {
  it("shows an open draft as a draft, and a closed one as closed", () => {
    expect(pullStateOf({ state: "open", draft: true })).toBe("draft");
    expect(pullStateOf({ state: "closed", draft: true })).toBe("closed");
    expect(pullStateOf({ state: "merged", draft: false })).toBe("merged");
  });

  it("titles a pull request after its branch's own name", () => {
    expect(titleOfBranch("ada/login-loop")).toBe("Login loop");
    expect(titleOfBranch("ada/feature/dark_mode")).toBe("Dark mode");
    expect(titleOfBranch("main")).toBe("Main");
    expect(titleOfBranch("fix/--")).toBe("fix/--");
  });
});

describe("the conversation", () => {
  it("folds a run of commits that mention it into one entry", () => {
    const entries = foldConversation([
      committed("a", 1),
      committed("b", 2),
      committed("c", 3),
      comment("C_1", "Looks good"),
      committed("d", 4),
    ]);
    expect(entries.map((entry) => entry._tag)).toEqual(["CommittedRun", "Comment", "Committed"]);
    const run = entries[0];
    expect(run?._tag === "CommittedRun" ? run.commits.map((commit) => commit.oid) : []).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(run?.at).toBe(1);
  });

  it("puts each thread under the review it was written in", () => {
    const threads = [
      thread({ id: "T_1", review: "R_1" }),
      thread({ id: "T_2", review: "R_1" }),
      thread({ id: "T_3", review: "R_2" }),
      thread({ id: "T_4" }),
    ];
    const byReview = threadsByReview(threads);
    expect(byReview.get("R_1")?.map((each) => each.id)).toEqual(["T_1", "T_2"]);
    expect(byReview.get("R_2")?.map((each) => each.id)).toEqual(["T_3"]);
    expect(byReview.size).toBe(2);
  });
});

describe("the brief a thread starts from", () => {
  it("says what the pull request is and asks for a look, not changes", () => {
    const brief = pullRequestBrief(
      pull({
        labels: [{ name: "bug", color: "d73a4a" }],
        reviewDecision: "changesRequested",
        checks: "failing",
      }),
      { worktree: false },
    );
    expect(brief).toMatch(/^Look into GitHub pull request #7, "Fix the login loop"/);
    expect(brief).toContain("merges `fix/login-loop` into `main`");
    expect(brief).toContain("2 files, +12 −3; changes requested; checks failing; labels: bug");
    expect(brief).toContain("Opened by ada.");
    expect(brief).toContain("Description:\nStops the redirect.");
    expect(brief).toContain("`gh pr diff 7`; don't switch this folder's branch");
    expect(brief).toMatch(/Don't change anything yet\.$/);
  });

  it("checks the pull request out first in a worktree of its own", () => {
    expect(pullRequestBrief(pull(), { worktree: true })).toContain("`gh pr checkout 7 --detach`");
  });

  it("quotes unresolved threads and visible comments, leaving out resolved and hidden ones", () => {
    const brief = pullRequestBrief(
      pull({
        body: "",
        threads: [
          thread(),
          thread({
            id: "T_2",
            resolved: true,
            comments: [{ id: "C_9", body: "Settled", at: 1, reactions: [] }],
          }),
        ],
        timeline: [
          comment("C_2", "Ship it"),
          comment("C_3", "Spam", { hidden: "Spam" }),
          {
            _tag: "Review",
            id: "R_1",
            author: { login: "lin" },
            body: "Not yet",
            at: 3,
            reactions: [],
            state: "changesRequested",
          },
        ],
      }),
      { worktree: false },
    );
    expect(brief).toContain("It has no description.");
    expect(brief).toContain("Unresolved review threads:\n\nsrc/login.ts:14\ngrace: Why here?");
    expect(brief).not.toContain("Settled");
    expect(brief).toContain("grace wrote:\nShip it");
    expect(brief).toContain("lin (requested changes) wrote:\nNot yet");
    expect(brief).not.toContain("Spam");
  });

  it("cuts a long history short and says there's more on GitHub", () => {
    const long = "x".repeat(5_000);
    const brief = pullRequestBrief(
      pull({
        body: long,
        timeline: Array.from({ length: 12 }, (_, index) => comment(`C_${index}`, long)),
      }),
      { worktree: false },
    );
    expect(brief.length).toBeLessThan(26_000);
    expect(brief).toContain("… (cut: 1000 more characters on GitHub)");
    expect(brief).toContain("More of the conversation is on GitHub than is quoted here.");
    expect(pullRequestBrief(pull({ timelineNext: "page-2" }), { worktree: false })).toContain(
      "More of the conversation is on GitHub",
    );
  });
});
