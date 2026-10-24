import type { GitHubRepository } from "@cerium/rpc";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { GitHub } from "../src/github.ts";
import {
  changedFileOf,
  checkOf,
  parseBranchPullRequest,
  parseChecks,
  parsePullRequestDetail,
  parsePullRequestPage,
  pullRequests,
  pullRequestSearch,
  reviewersOf,
  threadOf,
} from "../src/githubPulls.ts";

const actor = { login: "me", avatarUrl: "https://avatars/me" };

const node = {
  number: 7,
  title: "Add the thing",
  state: "OPEN",
  isDraft: true,
  url: "https://github.com/team/app/pull/7",
  createdAt: "2026-01-01T12:00:00Z",
  updatedAt: "2026-01-02T12:00:00Z",
  additions: 10,
  deletions: 2,
  author: actor,
  headRefName: "feature",
  baseRefName: "main",
  labels: { nodes: [{ name: "ui", color: "0e8a16" }, null] },
  comments: { totalCount: 3 },
  reviewDecision: "CHANGES_REQUESTED",
  mergeable: "CONFLICTING",
  commits: { totalCount: 4, nodes: [{ commit: { oid: "abc", statusCheckRollup: { state: "FAILURE" } } }] },
};

describe("searching", () => {
  it("narrows to the repository's pull requests in the state asked for", () => {
    expect(pullRequestSearch("team/app", {})).toBe("repo:team/app is:pr is:open sort:updated-desc");
    expect(pullRequestSearch("team/app", { state: "closed" })).toBe(
      "repo:team/app is:pr is:closed is:unmerged sort:updated-desc",
    );
    expect(pullRequestSearch("team/app", { state: "merged", createdByMe: true })).toBe(
      "repo:team/app is:pr is:merged author:@me sort:updated-desc",
    );
    expect(pullRequestSearch("team/app", { state: "all", reviewRequested: true, assignedToMe: true })).toBe(
      "repo:team/app is:pr review-requested:@me assignee:@me sort:updated-desc",
    );
  });

  it("keeps the user's words but not a search somewhere else", () => {
    expect(pullRequestSearch("team/app", { search: "fix  repo:other/x is:issue label:bug" })).toBe(
      "repo:team/app is:pr is:open fix label:bug sort:updated-desc",
    );
    // Words that choose a state or an order themselves win over the filters'.
    expect(pullRequestSearch("team/app", { search: "is:closed sort:created-asc" })).toBe(
      "repo:team/app is:pr is:closed sort:created-asc",
    );
  });

  it("reads a page of the list", () => {
    const page = parsePullRequestPage({
      search: { issueCount: 41, pageInfo: { hasNextPage: true, endCursor: "C1" }, nodes: [node, {}, null] },
    });
    expect(page).toEqual({
      pullRequests: [
        {
          number: 7,
          title: "Add the thing",
          state: "open",
          draft: true,
          url: "https://github.com/team/app/pull/7",
          author: actor,
          createdAt: Date.parse("2026-01-01T12:00:00Z"),
          updatedAt: Date.parse("2026-01-02T12:00:00Z"),
          head: "feature",
          base: "main",
          labels: [{ name: "ui", color: "0e8a16" }],
          comments: 3,
          reviewDecision: "changesRequested",
          mergeable: "conflicting",
          checks: "failing",
          additions: 10,
          deletions: 2,
        },
      ],
      total: 41,
      next: "C1",
    });
  });
});

describe("a pull request", () => {
  const thread = {
    id: "T1",
    path: "src/a.ts",
    line: 12,
    startLine: 12,
    originalLine: 11,
    diffSide: "RIGHT",
    isResolved: false,
    isOutdated: false,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    viewerCanReply: true,
    comments: {
      nodes: [
        {
          id: "C1",
          body: "Why?",
          createdAt: "2026-01-02T12:00:00Z",
          author: { login: "you" },
          diffHunk: "@@ -10,2 +10,3 @@ function a() {\n context\n+added",
          pullRequestReview: { id: "R1" },
        },
      ],
    },
  };

  it("reads a review thread with the lines it's on", () => {
    expect(threadOf(thread)).toEqual({
      id: "T1",
      path: "src/a.ts",
      side: "new",
      line: 12,
      originalLine: 11,
      hunk: {
        oldStart: 10,
        newStart: 10,
        lines: [
          { kind: "context", text: "context" },
          { kind: "added", text: "added" },
        ],
      },
      resolved: false,
      outdated: false,
      canResolve: true,
      canReply: true,
      review: "R1",
      comments: [
        {
          id: "C1",
          author: { login: "you" },
          body: "Why?",
          at: Date.parse("2026-01-02T12:00:00Z"),
          reactions: [],
          review: "R1",
        },
      ],
    });
    expect(threadOf({ ...thread, comments: { nodes: [] } })).toBeUndefined();
  });

  it("lists who reviews it, asked for first, without the author's own replies", () => {
    expect(
      reviewersOf(
        { nodes: [{ requestedReviewer: { login: "ann" } }, { requestedReviewer: { name: "core" } }] },
        {
          nodes: [
            { state: "APPROVED", author: { login: "bob" } },
            { state: "COMMENTED", author: { login: "me" } },
            { state: "CHANGES_REQUESTED", author: { login: "ann" } },
          ],
        },
        "me",
      ),
    ).toEqual([
      { name: "ann", state: "requested" },
      { name: "core", team: true, state: "requested" },
      { name: "bob", state: "approved" },
    ]);
  });

  it("reads the whole of it, leaving out reviews that only replied to threads", () => {
    const detail = parsePullRequestDetail(
      {
        repository: {
          pullRequest: {
            ...node,
            id: "PR1",
            body: "Body",
            headRefOid: "abc",
            headRepository: { nameWithOwner: "me/app" },
            headRef: null,
            mergeStateStatus: "DIRTY",
            viewerCanUpdate: true,
            viewerDidAuthor: true,
            changedFiles: 2,
            timelineItems: {
              totalCount: 2,
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  __typename: "PullRequestReview",
                  id: "R1",
                  body: "",
                  submittedAt: "2026-01-02T12:00:00Z",
                  state: "COMMENTED",
                  author: actor,
                },
                {
                  __typename: "PullRequestReview",
                  id: "R2",
                  body: "",
                  submittedAt: "2026-01-02T13:00:00Z",
                  state: "COMMENTED",
                  author: actor,
                },
              ],
            },
            reviewThreads: { nodes: [thread] },
          },
        },
      },
      "team/app",
    );
    expect(detail).toMatchObject({
      id: "PR1",
      headRepository: "me/app",
      headExists: false,
      mergeState: "dirty",
      commitCount: 4,
      canUpdate: true,
      mine: true,
      timelineTotal: 2,
      revision: "2026-01-02T12:00:00Z|abc|CONFLICTING|FAILURE",
    });
    expect(detail?.timeline.map((item) => (item._tag === "Review" ? item.id : item._tag))).toEqual(["R1"]);
    expect(parsePullRequestDetail({ repository: { pullRequest: null } }, "team/app")).toBeUndefined();
  });
});

describe("checks and files", () => {
  it("reads check runs and statuses, failures first", () => {
    const checks = parseChecks({
      repository: {
        pullRequest: {
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    state: "PENDING",
                    contexts: {
                      nodes: [
                        {
                          __typename: "CheckRun",
                          name: "Test",
                          status: "COMPLETED",
                          conclusion: "SUCCESS",
                          detailsUrl: "u1",
                          isRequired: true,
                          checkSuite: { workflowRun: { workflow: { name: "CI" } } },
                        },
                        {
                          __typename: "CheckRun",
                          name: "Lint",
                          status: "IN_PROGRESS",
                          conclusion: null,
                          checkSuite: { app: { name: "Actions" } },
                        },
                        {
                          __typename: "StatusContext",
                          context: "deploy",
                          state: "ERROR",
                          description: "Failed",
                          targetUrl: "u2",
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    });
    expect(checks).toEqual({
      state: "pending",
      checks: [
        { name: "deploy", state: "failure", description: "Failed", url: "u2", required: false },
        { name: "Lint", group: "Actions", state: "pending", required: false },
        { name: "Test", group: "CI", state: "success", url: "u1", required: true },
      ],
    });
    expect(
      checkOf({ __typename: "CheckRun", name: "x", status: "COMPLETED", conclusion: "TIMED_OUT" })?.state,
    ).toBe("failure");
  });

  it("reads a changed file's patch as hunks", () => {
    expect(
      changedFileOf({
        filename: "src/b.ts",
        previous_filename: "src/a.ts",
        status: "renamed",
        additions: 1,
        deletions: 1,
        patch: "@@ -1,2 +1,2 @@\n-old\n+new\n same",
      }),
    ).toEqual({
      path: "src/b.ts",
      from: "src/a.ts",
      status: "renamed",
      additions: 1,
      deletions: 1,
      hunks: [
        {
          oldStart: 1,
          newStart: 1,
          lines: [
            { kind: "removed", text: "old" },
            { kind: "added", text: "new" },
            { kind: "context", text: "same" },
          ],
        },
      ],
    });
    // GitHub sends no patch for a file too large to show.
    expect(
      changedFileOf({ filename: "big.json", status: "modified", additions: 9000, deletions: 0 }),
    ).toMatchObject({
      hunks: [],
      noDiff: true,
    });
  });

  it.effect("lists every changed file, a page at a time in order, up to the last that isn't full", () =>
    Effect.gen(function* () {
      /** GitHub with a pull request that changes `count` files, keeping which pages were asked for. */
      const changing = (count: number) => {
        const asked: Array<number> = [];
        const github = {
          repository: () =>
            Effect.succeed({ host: "github.com", owner: "team", name: "app" } as GitHubRepository),
          rest: (_host: string, _method: string, path: string) =>
            Effect.sync(() => {
              const page = Number(/[?&]page=(\d+)/.exec(path)?.[1]);
              asked.push(page);
              const start = (page - 1) * 100;
              return Array.from({ length: Math.max(0, Math.min(100, count - start)) }, (_, index) => ({
                filename: `f${start + index}.ts`,
                status: "modified",
                additions: 1,
                deletions: 0,
              }));
            }),
        } as unknown as GitHub["Service"];
        return { asked, files: pullRequests(github).files("/work", 7) };
      };
      const names = (listed: { readonly files: ReadonlyArray<{ readonly path: string }> }) =>
        listed.files.map((file) => file.path);

      const few = changing(42);
      const fewListed = yield* few.files;
      assert.deepStrictEqual(
        names(fewListed),
        Array.from({ length: 42 }, (_, index) => `f${index}.ts`),
      );
      assert.deepStrictEqual(few.asked, [1]);
      assert.isUndefined(fewListed.truncated);

      const many = changing(750);
      const manyListed = yield* many.files;
      assert.deepStrictEqual(
        names(manyListed),
        Array.from({ length: 750 }, (_, index) => `f${index}.ts`),
      );
      assert.isUndefined(manyListed.truncated);
      // Every page up to the first that isn't full, and only a few past it.
      assert.includeMembers(many.asked, [1, 2, 3, 4, 5, 6, 7, 8]);
      assert.isAtMost(Math.max(...many.asked), 13);

      // GitHub lists 3,000 at most.
      const most = yield* changing(5_000).files;
      assert.lengthOf(most.files, 3_000);
      assert.isTrue(most.truncated);
    }),
  );

  it("finds a branch's pull request from the repository it's pushed to", () => {
    const pull = (owner: string, state: string, number: number) => ({
      ...node,
      number,
      state,
      headRepositoryOwner: { login: owner },
    });
    expect(
      parseBranchPullRequest(
        {
          repository: {
            pullRequests: {
              nodes: [pull("someone", "OPEN", 9), pull("me", "MERGED", 8), pull("me", "OPEN", 5)],
            },
            pullRequestTemplates: [{ filename: "PULL_REQUEST_TEMPLATE.md", body: "## Why\n" }],
          },
        },
        "me",
      ),
    ).toMatchObject({ pullRequest: { number: 5 }, template: "## Why\n" });
  });
});
