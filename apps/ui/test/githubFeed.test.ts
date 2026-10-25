import type { GitHubRepository, IssueSummary, PullRequestSummary } from "@cerium/rpc";
import { describe, expect, it } from "@effect/vitest";

import {
  feedItems,
  feedKey,
  issueFiltersOf,
  matchesQuery,
  parseGitHubLink,
  pullFiltersOf,
  type FeedSource,
} from "../src/features/github/feed.ts";

const repository = (owner: string, name: string): GitHubRepository => ({
  host: "github.com",
  owner,
  name,
  url: `https://github.com/${owner}/${name}`,
  defaultBranch: "main",
  viewer: "me",
  permission: "write",
  mergeMethods: ["squash"],
  deleteBranchOnMerge: false,
  hasIssues: true,
  private: false,
});

const pull = (number: number, title: string, updatedAt: number): PullRequestSummary => ({
  number,
  title,
  state: "open",
  draft: false,
  url: "",
  author: { login: "someone" },
  createdAt: 0,
  updatedAt,
  head: "feature",
  base: "main",
  labels: [],
  comments: 0,
  mergeable: "mergeable",
  additions: 1,
  deletions: 0,
});

const issue = (number: number, title: string, updatedAt: number): IssueSummary => ({
  number,
  title,
  state: "open",
  url: "",
  createdAt: 0,
  updatedAt,
  comments: 0,
  labels: [],
  assignees: [],
  pullRequests: [],
});

const app: FeedSource = {
  root: "C:/code/app",
  repository: repository("acme", "app"),
  pulls: [pull(4, "Fix the login", 300)],
  issues: [issue(9, "Crash on start", 500)],
};
const site: FeedSource = {
  root: "C:/code/site",
  repository: repository("acme", "site"),
  pulls: [pull(2, "New landing page", 400)],
};

describe("feedItems", () => {
  it("lists every repository's pull requests and issues, newest activity first", () => {
    const items = feedItems([app, site]);
    expect(
      items.map((item) => `${item.repo}#${item.kind === "pr" ? item.pull.number : item.issue.number}`),
    ).toEqual(["acme/app#9", "acme/site#2", "acme/app#4"]);
  });

  it("reads a repository two projects share once, through the first", () => {
    const clone: FeedSource = { ...app, root: "D:/elsewhere/app" };
    const items = feedItems([app, clone]);
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.root === "C:/code/app")).toBe(true);
  });

  it("keys an item as the GitHub panel's tabs are keyed", () => {
    const [first] = feedItems([app]);
    expect(first === undefined ? undefined : feedKey(first)).toBe("github:C:/code/app\nissue\n9");
  });
});

describe("matchesQuery", () => {
  const [crash, fix] = feedItems([app]);

  it("finds an item by words of its title, its repository or its number", () => {
    expect(crash && matchesQuery(crash, "crash")).toBe(true);
    expect(crash && matchesQuery(crash, "acme/app start")).toBe(true);
    expect(fix && matchesQuery(fix, "#4")).toBe(true);
    expect(fix && matchesQuery(fix, "crash")).toBe(false);
    expect(fix && matchesQuery(fix, "   ")).toBe(true);
  });
});

describe("parseGitHubLink", () => {
  it("reads a pasted pull request or issue link", () => {
    expect(parseGitHubLink("https://github.com/acme/app/pull/12")).toEqual({
      repo: "acme/app",
      kind: "pr",
      number: 12,
    });
    expect(parseGitHubLink("github.com/acme/app/issues/7#issuecomment-1")).toEqual({
      repo: "acme/app",
      kind: "issue",
      number: 7,
    });
    expect(parseGitHubLink("https://github.com/acme/app/pull/12/files")?.number).toBe(12);
  });

  it("leaves anything else to the search", () => {
    expect(parseGitHubLink("fix the login")).toBeUndefined();
    expect(parseGitHubLink("https://gitlab.com/acme/app/pull/12")).toBeUndefined();
  });
});

describe("scopes", () => {
  it("asks pull requests and issues for the same people, and issues for no review", () => {
    expect(pullFiltersOf("mine")).toEqual({ createdByMe: true });
    expect(issueFiltersOf("assigned")).toEqual({ assignedToMe: true });
    expect(pullFiltersOf("review")).toEqual({ reviewRequested: true });
    expect(issueFiltersOf("review")).toBeUndefined();
    expect(issueFiltersOf("open")).toEqual({});
  });
});
