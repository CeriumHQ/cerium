import { GitHubError, type GitHubRepository } from "@cerium/rpc";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { parseConversation as parseTimeline } from "../src/githubConversation.ts";
import {
  issues,
  issueSearch,
  parseIssueChoices,
  parseIssueDetail,
  parseIssuePage,
  revisionOf,
  type IssueGitHub,
} from "../src/githubIssues.ts";

const AVATAR = "https://avatars.githubusercontent.com/u/1611510?v=4";
const actor = (login: string) => ({ login, avatarUrl: AVATAR, __typename: "User" });
const NO_REACTIONS = [
  "THUMBS_UP",
  "THUMBS_DOWN",
  "LAUGH",
  "HOORAY",
  "CONFUSED",
  "HEART",
  "ROCKET",
  "EYES",
].map((content) => ({ content, viewerHasReacted: false, reactors: { totalCount: 0 } }));
const at = (iso: string) => Date.parse(iso);

describe("issueSearch", () => {
  it("lists a repository's open issues, most recently updated first, when nothing narrows it", () => {
    expect(issueSearch("acme/app", {})).toBe("repo:acme/app is:issue is:open sort:updated-desc");
    expect(issueSearch("acme/app", { state: "closed" })).toBe(
      "repo:acme/app is:issue is:closed sort:updated-desc",
    );
    expect(issueSearch("acme/app", { state: "all" })).toBe("repo:acme/app is:issue sort:updated-desc");
  });

  it("narrows by who the issue is about", () => {
    expect(issueSearch("acme/app", { assignedToMe: true, createdByMe: true, mentioningMe: true })).toBe(
      "repo:acme/app is:issue is:open assignee:@me author:@me mentions:@me sort:updated-desc",
    );
    expect(issueSearch("acme/app", { assignedToMe: false })).toBe(
      "repo:acme/app is:issue is:open sort:updated-desc",
    );
  });

  it("quotes labels and milestones that hold spaces, and drops quotation marks", () => {
    expect(issueSearch("acme/app", { labels: ["bug", "good first issue", 'a"b'], milestone: "v 1.0" })).toBe(
      'repo:acme/app is:issue is:open label:bug label:"good first issue" label:ab milestone:"v 1.0" sort:updated-desc',
    );
  });

  it("asks for issues in no milestone unless one is named", () => {
    expect(issueSearch("acme/app", { noMilestone: true })).toContain(" no:milestone ");
    const both = issueSearch("acme/app", { noMilestone: true, milestone: "v2" });
    expect(both).toContain("milestone:v2");
    expect(both).not.toContain("no:milestone");
  });

  it("keeps the user's words but not qualifiers that search somewhere else", () => {
    expect(issueSearch("acme/app", { search: "crash   on  start" })).toBe(
      "repo:acme/app is:issue is:open crash on start sort:updated-desc",
    );
    expect(issueSearch("acme/app", { search: "repo:other/thing is:pr org:x crash -user:y" })).toBe(
      "repo:acme/app is:issue is:open crash sort:updated-desc",
    );
  });

  it("lets the user's own state and sort stand in for the defaults", () => {
    expect(issueSearch("acme/app", { search: "is:closed sort:comments-desc" })).toBe(
      "repo:acme/app is:issue is:closed sort:comments-desc",
    );
  });
});

describe("parseIssuePage", () => {
  const row = {
    number: 14718,
    title: "Help text refers to flags these commands do not have",
    state: "CLOSED",
    stateReason: "COMPLETED",
    url: "https://github.com/cli/cli/issues/14718",
    createdAt: "2026-10-16T15:54:05Z",
    updatedAt: "2026-10-21T01:21:21Z",
    author: actor("fjvbn2003"),
    comments: { totalCount: 3 },
    labels: { nodes: [{ name: "bug", color: "d73a4a", description: "Something isn't working" }] },
    assignees: { nodes: [actor("BagToad")] },
    milestone: { title: "v2.9" },
    closedByPullRequestsReferences: {
      nodes: [
        {
          number: 14719,
          title: "Fix help text",
          state: "MERGED",
          isDraft: false,
          url: "https://github.com/cli/cli/pull/14719",
          repository: { nameWithOwner: "cli/cli" },
        },
        {
          number: 7,
          state: "OPEN",
          isDraft: true,
          url: "https://github.com/fork/cli/pull/7",
          repository: { nameWithOwner: "fork/cli" },
        },
      ],
    },
  };

  it("reads a row with what the list shows of it", () => {
    const page = parseIssuePage(
      {
        search: {
          issueCount: 1035,
          pageInfo: { hasNextPage: true, endCursor: "Y3Vyc29yOjM=" },
          nodes: [row],
        },
      },
      "cli/cli",
    );
    expect(page.total).toBe(1035);
    expect(page.next).toBe("Y3Vyc29yOjM=");
    expect(page.issues).toEqual([
      {
        number: 14718,
        title: "Help text refers to flags these commands do not have",
        state: "closed",
        stateReason: "completed",
        url: "https://github.com/cli/cli/issues/14718",
        author: { login: "fjvbn2003", avatarUrl: AVATAR },
        createdAt: at("2026-10-16T15:54:05Z"),
        updatedAt: at("2026-10-21T01:21:21Z"),
        comments: 3,
        labels: [{ name: "bug", color: "d73a4a", description: "Something isn't working" }],
        assignees: [{ login: "BagToad", avatarUrl: AVATAR }],
        milestone: "v2.9",
        pullRequests: [
          {
            number: 14719,
            title: "Fix help text",
            state: "merged",
            url: "https://github.com/cli/cli/pull/14719",
          },
          {
            number: 7,
            state: "open",
            draft: true,
            url: "https://github.com/fork/cli/pull/7",
            repository: "fork/cli",
          },
        ],
      },
    ]);
  });

  it("ends on the last page, and skips what isn't an issue", () => {
    const page = parseIssuePage({
      search: {
        issueCount: 2,
        pageInfo: { hasNextPage: false, endCursor: "x" },
        // A search that finds a pull request or a hidden item answers an empty object or a null.
        nodes: [{}, null, { ...row, state: "OPEN", stateReason: null, author: null, milestone: null }],
      },
    });
    expect(page.next).toBeUndefined();
    expect(page.issues.map((issue) => issue.number)).toEqual([14718]);
    expect(page.issues[0]).not.toHaveProperty("author");
    expect(page.issues[0]).not.toHaveProperty("stateReason");
    expect(page.issues[0]).not.toHaveProperty("milestone");
  });
});

describe("parseTimeline", () => {
  const comment = {
    __typename: "IssueComment",
    id: "IC_kwDODKw3uc6keeTg",
    body: "`gh run list` has been fixed in https://github.com/cli/cli/pull/10222",
    createdAt: "2025-03-27T20:54:09Z",
    lastEditedAt: "2025-03-27T20:54:20Z",
    isMinimized: false,
    minimizedReason: null,
    authorAssociation: "MEMBER",
    url: "https://github.com/cli/cli/issues/9228#issuecomment-2759451872",
    author: actor("BagToad"),
    reactionGroups: NO_REACTIONS.map((group) =>
      group.content === "THUMBS_UP"
        ? { ...group, viewerHasReacted: true, reactors: { totalCount: 2 } }
        : group,
    ),
  };

  it("reads a comment with its reactions, edit time and standing", () => {
    expect(parseTimeline([comment])).toEqual([
      {
        _tag: "Comment",
        id: "IC_kwDODKw3uc6keeTg",
        author: { login: "BagToad", avatarUrl: AVATAR },
        body: "`gh run list` has been fixed in https://github.com/cli/cli/pull/10222",
        at: at("2025-03-27T20:54:09Z"),
        edited: at("2025-03-27T20:54:20Z"),
        association: "member",
        reactions: [{ kind: "thumbsUp", count: 2, mine: true }],
        url: "https://github.com/cli/cli/issues/9228#issuecomment-2759451872",
      },
    ]);
  });

  it("keeps a hidden comment's reason, and a comment of a deleted account without an author", () => {
    const [hidden] = parseTimeline([
      {
        ...comment,
        isMinimized: true,
        minimizedReason: "OFF_TOPIC",
        author: null,
        authorAssociation: "NONE",
      },
    ]);
    expect(hidden).toMatchObject({ _tag: "Comment", hidden: "off topic" });
    expect(hidden).not.toHaveProperty("author");
    expect(hidden).not.toHaveProperty("association");
  });

  it("joins the labels one person changed in a go into one entry, netting out those undone", () => {
    const labeled = (name: string, createdAt: string, kind = "LabeledEvent", by = "williammartin") => ({
      __typename: kind,
      createdAt,
      actor: actor(by),
      label: { name, color: "d73a4a" },
    });
    const items = parseTimeline([
      labeled("needs-triage", "2026-10-16T15:54:17Z", "LabeledEvent", "github-actions"),
      labeled("bug", "2026-10-19T14:58:28Z"),
      labeled("priority-3", "2026-10-19T14:58:29Z"),
      labeled("gh-ruleset", "2026-10-19T14:58:29Z"),
      labeled("priority-3", "2026-10-19T14:58:33Z", "UnlabeledEvent"),
      labeled("needs-triage", "2026-10-19T14:58:33Z", "UnlabeledEvent"),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ _tag: "Labels", actor: { login: "github-actions" } });
    expect(items[1]).toMatchObject({
      _tag: "Labels",
      actor: { login: "williammartin" },
      added: [{ name: "bug" }, { name: "gh-ruleset" }],
      removed: [{ name: "needs-triage" }],
    });
  });

  it("keeps labels apart when another person or a long while comes between", () => {
    const labeled = (name: string, createdAt: string, by: string) => ({
      __typename: "LabeledEvent",
      createdAt,
      actor: actor(by),
      label: { name, color: "ededed" },
    });
    expect(
      parseTimeline([
        labeled("a", "2026-10-19T14:58:00Z", "ana"),
        labeled("b", "2026-10-19T14:58:10Z", "bo"),
        labeled("c", "2026-10-19T15:10:00Z", "bo"),
      ]).map((item) => item._tag === "Labels" && item.added.map((each) => each.name)),
    ).toEqual([["a"], ["b"], ["c"]]);
  });

  it("reads who closed it and why, and the pull request or commit that did", () => {
    const items = parseTimeline([
      {
        __typename: "ClosedEvent",
        createdAt: "2026-10-19T18:28:47Z",
        actor: actor("BagToad"),
        stateReason: "NOT_PLANNED",
        closer: { __typename: "PullRequest", number: 14719, url: "https://github.com/cli/cli/pull/14719" },
      },
      { __typename: "ReopenedEvent", createdAt: "2026-10-19T18:30:00Z", actor: actor("BagToad") },
      {
        __typename: "ClosedEvent",
        createdAt: "2026-10-20T18:30:00Z",
        actor: actor("BagToad"),
        stateReason: "COMPLETED",
        closer: {
          __typename: "Commit",
          abbreviatedOid: "1a2b3c4",
          url: "https://github.com/cli/cli/commit/1a2b3c4",
        },
      },
      {
        __typename: "ClosedEvent",
        createdAt: "2026-10-21T18:30:00Z",
        actor: null,
        stateReason: null,
        closer: null,
      },
    ]);
    expect(items).toMatchObject([
      {
        _tag: "Closed",
        reason: "notPlanned",
        by: { label: "#14719", url: "https://github.com/cli/cli/pull/14719" },
      },
      { _tag: "Reopened" },
      { _tag: "Closed", reason: "completed", by: { label: "1a2b3c4" } },
      { _tag: "Closed" },
    ]);
    expect(items[3]).not.toHaveProperty("reason");
    expect(items[3]).not.toHaveProperty("by");
    expect(items[3]).not.toHaveProperty("actor");
  });

  it("reads the other events, and skips kinds this version doesn't know", () => {
    const items = parseTimeline(
      [
        {
          __typename: "CrossReferencedEvent",
          createdAt: "2026-10-16T18:10:59Z",
          actor: actor("BagToad"),
          isCrossRepository: true,
          willCloseTarget: true,
          source: {
            __typename: "PullRequest",
            number: 14719,
            title: "Fix help text",
            url: "https://github.com/fork/cli/pull/14719",
            repository: { nameWithOwner: "fork/cli" },
          },
        },
        {
          __typename: "RenamedTitleEvent",
          createdAt: "2026-10-17T00:00:00Z",
          actor: actor("ana"),
          previousTitle: "a",
          currentTitle: "b",
        },
        {
          __typename: "MilestonedEvent",
          createdAt: "2026-10-17T01:00:00Z",
          actor: actor("ana"),
          milestoneTitle: "v2",
        },
        {
          __typename: "DemilestonedEvent",
          createdAt: "2026-10-17T02:00:00Z",
          actor: actor("ana"),
          milestoneTitle: "v2",
        },
        {
          __typename: "AssignedEvent",
          createdAt: "2026-10-17T03:00:00Z",
          actor: actor("ana"),
          assignee: { __typename: "User", login: "bo" },
        },
        {
          __typename: "UnassignedEvent",
          createdAt: "2026-10-17T03:00:05Z",
          actor: actor("ana"),
          assignee: { __typename: "User", login: "cy" },
        },
        {
          __typename: "LockedEvent",
          createdAt: "2026-10-17T04:00:00Z",
          actor: actor("ana"),
          lockReason: "TOO_HEATED",
        },
        { __typename: "UnlockedEvent", createdAt: "2026-10-17T05:00:00Z", actor: actor("ana") },
        {
          __typename: "ReferencedEvent",
          createdAt: "2026-10-17T06:00:00Z",
          actor: actor("ana"),
          commit: {
            abbreviatedOid: "abc1234",
            messageHeadline: "Fix it",
            url: "https://github.com/cli/cli/commit/abc1234",
          },
        },
        {
          __typename: "ConnectedEvent",
          createdAt: "2026-10-17T07:00:00Z",
          actor: actor("ana"),
          subject: {
            __typename: "PullRequest",
            number: 5,
            title: "Five",
            url: "https://github.com/cli/cli/pull/5",
            repository: { nameWithOwner: "cli/cli" },
          },
        },
        {
          __typename: "MarkedAsDuplicateEvent",
          createdAt: "2026-10-17T08:00:00Z",
          actor: actor("ana"),
          canonical: {
            __typename: "Issue",
            number: 9228,
            title: "Original",
            url: "https://github.com/cli/cli/issues/9228",
            repository: { nameWithOwner: "cli/cli" },
          },
        },
        {
          __typename: "TransferredEvent",
          createdAt: "2026-10-17T09:00:00Z",
          actor: actor("ana"),
          fromRepository: { nameWithOwner: "cli/old" },
        },
        { __typename: "SubscribedEvent", createdAt: "2026-10-17T10:00:00Z", actor: actor("ana") },
        { __typename: "RenamedTitleEvent", createdAt: "not a time" },
      ],
      "cli/cli",
    );
    expect(items).toMatchObject([
      {
        _tag: "Referenced",
        closes: true,
        by: { kind: "pullRequest", number: 14719, repository: "fork/cli" },
      },
      { _tag: "Renamed", from: "a", to: "b" },
      { _tag: "Milestone", title: "v2", removed: false },
      { _tag: "Milestone", title: "v2", removed: true },
      { _tag: "Assignees", added: ["bo"], removed: ["cy"] },
      { _tag: "Locked", locked: true, reason: "too heated" },
      { _tag: "Locked", locked: false },
      { _tag: "Committed", oid: "abc1234", headline: "Fix it" },
      { _tag: "Linked", unlinked: false, subject: { kind: "pullRequest", number: 5 } },
      { _tag: "Duplicate", of: { kind: "issue", number: 9228 } },
      { _tag: "Transferred", from: "cli/old" },
    ]);
    expect(items).toHaveLength(11);
    expect(items[8]).not.toHaveProperty("subject.repository");
  });
});

describe("parseIssueDetail", () => {
  const answer = (timeline: object) => ({
    repository: {
      issue: {
        id: "I_kwDODKw3uc8AAAABXuaZzA",
        number: 14718,
        title: "Help text refers to flags these commands do not have",
        state: "CLOSED",
        stateReason: "COMPLETED",
        url: "https://github.com/cli/cli/issues/14718",
        body: "### Describe the bug\r\n\r\nIt does.",
        createdAt: "2026-10-16T15:54:05Z",
        updatedAt: "2026-10-21T01:21:21Z",
        closedAt: "2026-10-19T18:28:47Z",
        locked: false,
        authorAssociation: "NONE",
        author: actor("fjvbn2003"),
        labels: { nodes: [{ name: "bug", color: "d73a4a", description: "Something isn't working" }] },
        assignees: { nodes: [] },
        milestone: {
          title: "v2.9",
          url: "https://github.com/cli/cli/milestone/9",
          state: "OPEN",
          dueOn: "2026-12-01T00:00:00Z",
        },
        reactionGroups: NO_REACTIONS,
        comments: { totalCount: 1 },
        closedByPullRequestsReferences: { nodes: [] },
        linkedBranches: {
          nodes: [
            { ref: { name: "14718-fix-help", repository: { nameWithOwner: "cli/cli" } } },
            { ref: { name: "wip", repository: { nameWithOwner: "fork/cli" } } },
            { ref: null },
          ],
        },
        timelineItems: timeline,
      },
    },
  });

  it("reads the issue with its first page of conversation", () => {
    const detail = parseIssueDetail(
      answer({
        totalCount: 250,
        pageInfo: { hasNextPage: true, endCursor: "Y3Vyc29y" },
        nodes: [{ __typename: "ReopenedEvent", createdAt: "2026-10-19T18:30:00Z", actor: actor("BagToad") }],
      }),
      "cli/cli",
    );
    expect(detail).toMatchObject({
      id: "I_kwDODKw3uc8AAAABXuaZzA",
      number: 14718,
      state: "closed",
      stateReason: "completed",
      body: "### Describe the bug\r\n\r\nIt does.",
      closedAt: at("2026-10-19T18:28:47Z"),
      locked: false,
      reactions: [],
      comments: 1,
      milestone: "v2.9",
      milestoneDetail: {
        title: "v2.9",
        url: "https://github.com/cli/cli/milestone/9",
        dueOn: at("2026-12-01T00:00:00Z"),
        open: true,
      },
      branches: [{ name: "14718-fix-help" }, { name: "wip", repository: "fork/cli" }],
      timeline: [{ _tag: "Reopened" }],
      more: true,
      canUpdate: false,
      revision: "2026-10-21T01:21:21Z|CLOSED|1",
    });
    // The outsider who opened it gets no badge.
    expect(detail).not.toHaveProperty("association");
  });

  it("reads an issue the repository doesn't have as none", () => {
    expect(parseIssueDetail({ repository: { issue: null } })).toBeUndefined();
    expect(parseIssueDetail({ repository: null })).toBeUndefined();
  });
});

describe("parseIssueChoices", () => {
  it("reads the labels and milestones on offer, and who is signed in", () => {
    expect(
      parseIssueChoices({
        viewer: actor("nonlooped"),
        repository: {
          labels: {
            nodes: [
              { name: "bug", color: "d73a4a", description: "" },
              { name: "docs", color: "0075ca" },
            ],
          },
          milestones: {
            nodes: [{ title: "v1", url: "https://github.com/a/b/milestone/1", state: "OPEN", dueOn: null }],
          },
        },
      }),
    ).toEqual({
      me: { login: "nonlooped", avatarUrl: AVATAR },
      labels: [
        { name: "bug", color: "d73a4a" },
        { name: "docs", color: "0075ca" },
      ],
      milestones: [{ title: "v1", url: "https://github.com/a/b/milestone/1", open: true }],
    });
  });
});

describe("revisionOf", () => {
  it("changes with a new comment, a closing or an edit, and with nothing else", () => {
    const issue = { updatedAt: "2026-10-21T01:21:21Z", state: "OPEN", comments: { totalCount: 2 } };
    const same = revisionOf({ ...issue });
    expect(revisionOf({ ...issue, extra: 1 })).toBe(same);
    expect(revisionOf({ ...issue, comments: { totalCount: 3 } })).not.toBe(same);
    expect(revisionOf({ ...issue, state: "CLOSED" })).not.toBe(same);
    expect(revisionOf({ ...issue, updatedAt: "2026-10-21T01:22:00Z" })).not.toBe(same);
  });
});

const REPOSITORY = {
  host: "github.com",
  owner: "acme",
  name: "app",
  url: "https://github.com/acme/app",
  defaultBranch: "main",
  viewer: "nonlooped",
  permission: "write",
  mergeMethods: ["merge"],
  deleteBranchOnMerge: false,
  hasIssues: true,
  private: false,
} satisfies GitHubRepository;

interface Call {
  readonly kind: "graphql" | "rest";
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly method?: string;
  readonly path?: string;
  readonly body?: unknown;
}

/** GitHub as `issues` sees it: what was asked of it is in `calls`, and `answers` are given in turn. */
const fakeGitHub = (
  answers: ReadonlyArray<unknown> = [],
  repository: GitHubRepository = REPOSITORY,
  rest: (method: string, path: string) => unknown = () => ({}),
) => {
  const calls: Array<Call> = [];
  const queue = [...answers];
  const github: IssueGitHub = {
    repository: () => Effect.succeed(repository),
    graphql: (_host, _query, variables) =>
      Effect.sync(() => {
        calls.push({ kind: "graphql", variables });
        return queue.shift();
      }),
    rest: (_host, method, path, body) => {
      calls.push({ kind: "rest", method, path, body });
      const answer = rest(method, path);
      return answer instanceof GitHubError ? Effect.fail(answer) : Effect.succeed(answer);
    },
  };
  return { github, calls };
};

describe("issues", () => {
  it.effect("won't list the issues of a repository that has them turned off", () =>
    Effect.gen(function* () {
      const { github, calls } = fakeGitHub([], { ...REPOSITORY, hasIssues: false });
      const exit = yield* Effect.exit(issues(github).list("/work", {}));
      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(calls, []);
    }),
  );

  it.effect("closes with the comment first, and says why", () =>
    Effect.gen(function* () {
      const { github, calls } = fakeGitHub();
      yield* issues(github).close("/work", 7, "notPlanned", "Out of scope");
      yield* issues(github).close("/work", 8, "completed", "  ");
      assert.deepStrictEqual(calls, [
        {
          kind: "rest",
          method: "POST",
          path: "repos/acme/app/issues/7/comments",
          body: { body: "Out of scope" },
        },
        {
          kind: "rest",
          method: "PATCH",
          path: "repos/acme/app/issues/7",
          body: { state: "closed", state_reason: "not_planned" },
        },
        {
          kind: "rest",
          method: "PATCH",
          path: "repos/acme/app/issues/8",
          body: { state: "closed", state_reason: "completed" },
        },
      ]);
    }),
  );

  it.effect("changes labels and assignees, leaving alone the labels already gone", () =>
    Effect.gen(function* () {
      const gone = new GitHubError({ reason: "notFound", message: "no such label" });
      const { github, calls } = fakeGitHub([], REPOSITORY, (method, path) =>
        method === "DELETE" && path.endsWith("/labels/old%20one") ? gone : {},
      );
      yield* issues(github).update("/work", 3, {
        addLabels: ["bug"],
        removeLabels: ["old one", "stale"],
        addAssignees: ["nonlooped"],
        removeAssignees: ["someone"],
      });
      assert.deepStrictEqual(
        calls.map(({ method, path, body }) => [method, path, body]),
        [
          ["POST", "repos/acme/app/issues/3/labels", { labels: ["bug"] }],
          ["DELETE", "repos/acme/app/issues/3/labels/old%20one", undefined],
          ["DELETE", "repos/acme/app/issues/3/labels/stale", undefined],
          ["POST", "repos/acme/app/issues/3/assignees", { assignees: ["nonlooped"] }],
          ["DELETE", "repos/acme/app/issues/3/assignees", { assignees: ["someone"] }],
        ],
      );
    }),
  );

  it.effect("fails when a label can't be removed for another reason", () =>
    Effect.gen(function* () {
      const refused = new GitHubError({ reason: "failed", message: "Must have push access" });
      const { github } = fakeGitHub([], REPOSITORY, () => refused);
      const exit = yield* Effect.exit(issues(github).update("/work", 3, { removeLabels: ["bug"] }));
      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("opens an issue and answers with its number", () =>
    Effect.gen(function* () {
      const { github, calls } = fakeGitHub([], REPOSITORY, () => ({
        number: 12,
        html_url: "https://github.com/acme/app/issues/12",
      }));
      const created = yield* issues(github).create("/work", "It breaks", "Steps…", ["bug"]);
      assert.deepStrictEqual(created, { number: 12, url: "https://github.com/acme/app/issues/12" });
      yield* issues(github).create("/work", "No labels", "", []);
      assert.deepStrictEqual(
        calls.map(({ body }) => body),
        [
          { title: "It breaks", body: "Steps…", labels: ["bug"] },
          { title: "No labels", body: "" },
        ],
      );
    }),
  );

  const comment = (n: number) => ({
    __typename: "IssueComment",
    id: `IC_${n}`,
    body: `Comment ${n}`,
    createdAt: `2026-10-0${n}T10:00:00Z`,
    isMinimized: false,
    author: actor("ana"),
    reactionGroups: NO_REACTIONS,
  });

  const detailAnswer = (nodes: ReadonlyArray<object>, next: string | null, total: number) => ({
    repository: {
      issue: {
        id: "I_1",
        number: 5,
        title: "Five",
        state: "OPEN",
        url: "https://github.com/acme/app/issues/5",
        body: "Body",
        createdAt: "2026-10-01T09:00:00Z",
        updatedAt: "2026-10-05T10:00:00Z",
        locked: false,
        viewerCanUpdate: true,
        comments: { totalCount: total },
        timelineItems: {
          totalCount: total,
          pageInfo: { hasNextPage: next !== null, endCursor: next },
          nodes,
        },
      },
    },
  });

  it.effect("reads more of the conversation until it has the entries asked for", () =>
    Effect.gen(function* () {
      const { github, calls } = fakeGitHub([
        detailAnswer([comment(1), comment(2)], "P2", 5),
        detailAnswer([comment(3), comment(4)], "P3", 5),
        detailAnswer([comment(5)], null, 5),
      ]);
      const detail = yield* issues(github).detail("/work", 5, 100);
      assert.deepStrictEqual(
        detail.timeline.map((item) => item._tag === "Comment" && item.id),
        ["IC_1", "IC_2", "IC_3", "IC_4", "IC_5"],
      );
      assert.notProperty(detail, "more");
      assert.isTrue(detail.canUpdate);
      assert.deepStrictEqual(
        calls.map((call) => call.variables?.["after"]),
        [null, "P2", "P3"],
      );
    }),
  );

  it.effect("stops reading at the entries asked for, and says where to go on", () =>
    Effect.gen(function* () {
      const { github, calls } = fakeGitHub([detailAnswer([comment(1), comment(2)], "P2", 5)]);
      const detail = yield* issues(github).detail("/work", 5, 2);
      assert.lengthOf(detail.timeline, 2);
      assert.isTrue(detail.more);
      assert.lengthOf(calls, 1);
      assert.strictEqual(calls[0]?.variables?.["first"], 2);
    }),
  );

  it.effect("fails for an issue the repository doesn't have", () =>
    Effect.gen(function* () {
      const { github } = fakeGitHub([{ repository: { issue: null } }]);
      const read = yield* Effect.flip(issues(github).detail("/work", 99, 100));
      assert.strictEqual(read.reason, "notFound");
      assert.strictEqual(read.message, "This repository has no issue #99.");
    }),
  );
});
