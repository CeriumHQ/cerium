import {
  GitHubError,
  IssueRpcs,
  type ConversationPage,
  type CloseReason,
  type CreatedIssue,
  type GitHubRepository,
  type IssueChoices,
  type IssueDetail,
  type IssueFilters,
  type IssueMilestone,
  type IssuePage,
  type IssueSummary,
  type LinkedPullRequest,
} from "@cerium/rpc";
import { Effect } from "effect";

import type { GitHub } from "./github.ts";
import {
  ACTOR,
  LABEL,
  REACTIONS,
  SHARED_TIMELINE_FIELDS,
  SHARED_TIMELINE_TYPES,
  association,
  elsewhere,
  flag,
  json,
  label,
  nextCursor,
  nodesOf,
  parseConversation,
  reactions,
  stateReason,
  text,
  time,
  user,
  whole,
  type Json,
} from "./githubConversation.ts";

// What the Issues tab and the issue viewer need from GitHub, through the user's `gh`: a repository's
// issues as a search a page at a time, one issue with its conversation, and the actions on it. The
// readers are plain functions, so they can be tested against real answers; the conversation's own are
// githubConversation.ts's, shared with pull requests.

/** Issues in a page of the list. */
const PAGE = 30;

/** Entries of a conversation in a page. */
const TIMELINE_PAGE = 100;

// ---------------------------------------------------------------------------------------------
// Searching

/** Qualifiers of the user's own words that would leave the repository or the issues, which they can't. */
const FOREIGN_QUALIFIER = /^-?(?:repo|org|user|type|is:pr|is:pull-request|in:pr)\b/i;

/** Whether the user's words choose open or closed issues themselves. */
const STATE_QUALIFIER = /(?:^|\s)-?is:(?:open|closed)\b/i;

/** A qualifier's value, quoted when it holds spaces. A quotation mark can't be in one, so it goes. */
const qualifier = (name: string, value: string) => {
  const clean = value.replaceAll('"', "").trim();
  return /[\s:]/.test(clean) ? `${name}:"${clean}"` : `${name}:${clean}`;
};

/**
 * The words of GitHub's search for the issues of `repository` (`owner/name`) that `filters` ask for,
 * most recently updated first. The user's own words are kept as they typed them, except for
 * qualifiers that would search somewhere else.
 */
export const issueSearch = (repository: string, filters: IssueFilters): string => {
  const own = (filters.search ?? "")
    .split(/\s+/)
    .filter((word) => word !== "" && !FOREIGN_QUALIFIER.test(word))
    .join(" ");
  const parts = [`repo:${repository}`, "is:issue"];
  const state = filters.state ?? "open";
  if (state !== "all" && !STATE_QUALIFIER.test(own)) parts.push(`is:${state}`);
  if (filters.assignedToMe === true) parts.push("assignee:@me");
  if (filters.createdByMe === true) parts.push("author:@me");
  if (filters.mentioningMe === true) parts.push("mentions:@me");
  for (const each of filters.labels ?? []) {
    if (each.trim() !== "") parts.push(qualifier("label", each));
  }
  if (filters.milestone !== undefined && filters.milestone.trim() !== "") {
    parts.push(qualifier("milestone", filters.milestone));
  } else if (filters.noMilestone === true) {
    parts.push("no:milestone");
  }
  if (own !== "") parts.push(own);
  if (!/(?:^|\s)sort:/i.test(own)) parts.push("sort:updated-desc");
  return parts.join(" ");
};

// ---------------------------------------------------------------------------------------------
// Queries

const PULL_REQUESTS =
  "closedByPullRequestsReferences(first: 3, includeClosedPrs: true) { nodes { number title state isDraft url repository { nameWithOwner } } }";

/** The row of the Issues tab, and the one query that lists them: `$q` is `issueSearch`'s words. */
export const LIST_QUERY = `query($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Issue {
        number title state stateReason url createdAt updatedAt
        author { ${ACTOR} }
        comments { totalCount }
        labels(first: 10) { nodes { ${LABEL} } }
        assignees(first: 10) { nodes { ${ACTOR} } }
        milestone { title }
        ${PULL_REQUESTS}
      }
    }
  }
}`;

const TIMELINE = `timelineItems(first: $first, after: $after, itemTypes: [${SHARED_TIMELINE_TYPES.join(", ")}]) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes { ${SHARED_TIMELINE_FIELDS} }
  }`;

/** One issue with a page of its conversation. */
export const DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      id number title state stateReason url body createdAt updatedAt lastEditedAt closedAt locked
      authorAssociation viewerCanUpdate
      author { ${ACTOR} }
      labels(first: 50) { nodes { ${LABEL} } }
      assignees(first: 20) { nodes { ${ACTOR} } }
      milestone { title url state dueOn }
      ${REACTIONS}
      comments { totalCount }
      closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number title state isDraft url repository { nameWithOwner } } }
      linkedBranches(first: 10) { nodes { ref { name repository { nameWithOwner } } } }
      ${TIMELINE}
    }
  }
}`;

/** The next page of one issue's conversation. */
export const TIMELINE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) { issue(number: $number) { ${TIMELINE} } }
}`;

/** What `IssueChanged` compares: little, so polling costs the rate limit next to nothing. */
export const REVISION_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { updatedAt state comments { totalCount } } }
}`;

/** The labels and milestones to choose from, and who is signed in. */
export const CHOICES_QUERY = `query($owner: String!, $name: String!) {
  viewer { ${ACTOR} }
  repository(owner: $owner, name: $name) {
    labels(first: 100, orderBy: { field: NAME, direction: ASC }) { nodes { ${LABEL} } }
    milestones(first: 50, states: OPEN, orderBy: { field: DUE_DATE, direction: ASC }) { nodes { title url state dueOn } }
  }
}`;

// ---------------------------------------------------------------------------------------------
// Reading GraphQL's answers

const PULL_REQUEST_STATES: Readonly<Record<string, LinkedPullRequest["state"]>> = {
  OPEN: "open",
  CLOSED: "closed",
  MERGED: "merged",
};

const pullRequest = (value: Json, own: string | undefined): LinkedPullRequest | undefined => {
  const number = whole(value["number"]);
  const url = text(value["url"]);
  if (number === undefined || url === undefined) return undefined;
  const title = text(value["title"]);
  const repository = elsewhere(value["repository"], own);
  return {
    number,
    ...(title === undefined ? {} : { title }),
    state: PULL_REQUEST_STATES[text(value["state"]) ?? ""] ?? "open",
    ...(value["isDraft"] === true ? { draft: true } : {}),
    url,
    ...(repository === undefined ? {} : { repository }),
  };
};

const summary = (issue: Json, own: string | undefined): IssueSummary | undefined => {
  const number = whole(issue["number"]);
  const url = text(issue["url"]);
  const createdAt = time(issue["createdAt"]);
  if (number === undefined || url === undefined || createdAt === undefined) return undefined;
  const author = user(issue["author"]);
  const reason = stateReason(issue["stateReason"]);
  const milestone = text(json(issue["milestone"])?.["title"]);
  return {
    number,
    title: text(issue["title"]) ?? "",
    state: issue["state"] === "CLOSED" ? "closed" : "open",
    ...(reason === undefined || issue["state"] !== "CLOSED" ? {} : { stateReason: reason }),
    url,
    ...(author === undefined ? {} : { author }),
    createdAt,
    updatedAt: time(issue["updatedAt"]) ?? createdAt,
    comments: whole(json(issue["comments"])?.["totalCount"]) ?? 0,
    labels: nodesOf(issue["labels"]).flatMap((each) => label(each) ?? []),
    assignees: nodesOf(issue["assignees"]).flatMap((each) => user(each) ?? []),
    ...(milestone === undefined ? {} : { milestone }),
    pullRequests: nodesOf(issue["closedByPullRequestsReferences"]).flatMap(
      (each) => pullRequest(each, own) ?? [],
    ),
  };
};

/** A page of `LIST_QUERY`'s `data`; `own` is the repository, `owner/name`. */
export const parseIssuePage = (data: unknown, own?: string): IssuePage => {
  const search = json(json(data)?.["search"]);
  const cursor = nextCursor(search);
  const issues = nodesOf(search).flatMap((each) => summary(each, own) ?? []);
  return {
    issues,
    total: whole(search?.["issueCount"]) ?? issues.length,
    ...(cursor === undefined ? {} : { next: cursor }),
  };
};

const issueOf = (data: unknown): Json | undefined => json(json(json(data)?.["repository"])?.["issue"]);

/** One page of the conversation of the issue in `TIMELINE_QUERY`'s `data`. */
export const parseTimelinePage = (data: unknown, own?: string): ConversationPage => {
  const connection = json(issueOf(data)?.["timelineItems"]);
  const cursor = nextCursor(connection);
  return {
    items: parseConversation(nodesOf(connection), own),
    ...(cursor === undefined ? {} : { next: cursor }),
  };
};

const milestone = (value: unknown): IssueMilestone | undefined => {
  const each = json(value);
  const title = text(each?.["title"]);
  if (title === undefined) return undefined;
  const url = text(each?.["url"]);
  const dueOn = time(each?.["dueOn"]);
  return {
    title,
    ...(url === undefined ? {} : { url }),
    ...(dueOn === undefined ? {} : { dueOn }),
    open: each?.["state"] !== "CLOSED",
  };
};

/** What `IssueChanged` compares, from its own answer or the detail's. */
export const revisionOf = (issue: Json): string =>
  [
    text(issue["updatedAt"]) ?? "",
    text(issue["state"]) ?? "",
    String(whole(json(issue["comments"])?.["totalCount"]) ?? 0),
  ].join("|");

/** `DETAIL_QUERY`'s `data`; none when the repository has no such issue. */
export const parseIssueDetail = (data: unknown, own?: string): IssueDetail | undefined => {
  const issue = issueOf(data);
  if (issue === undefined) return undefined;
  const head = summary(issue, own);
  const id = text(issue["id"]);
  if (head === undefined || id === undefined) return undefined;
  const standing = association(issue["authorAssociation"]);
  const edited = time(issue["lastEditedAt"]);
  const closedAt = time(issue["closedAt"]);
  const detail = milestone(issue["milestone"]);
  const page = parseTimelinePage(data, own);
  return {
    ...head,
    id,
    body: text(issue["body"]) ?? "",
    ...(standing === undefined ? {} : { association: standing }),
    ...(edited === undefined ? {} : { edited }),
    ...(closedAt === undefined ? {} : { closedAt }),
    locked: flag(issue["locked"]),
    reactions: reactions(issue["reactionGroups"]),
    ...(detail === undefined ? {} : { milestoneDetail: detail }),
    branches: nodesOf(issue["linkedBranches"]).flatMap((each) => {
      const ref = json(each["ref"]);
      const name = text(ref?.["name"]);
      const repository = elsewhere(ref?.["repository"], own);
      return name === undefined ? [] : [{ name, ...(repository === undefined ? {} : { repository }) }];
    }),
    canUpdate: flag(issue["viewerCanUpdate"]),
    timeline: page.items,
    ...(page.next === undefined ? {} : { more: true }),
    revision: revisionOf(issue),
  };
};

/** `CHOICES_QUERY`'s `data`; none when nobody is signed in. */
export const parseIssueChoices = (data: unknown): IssueChoices | undefined => {
  const me = user(json(data)?.["viewer"]);
  if (me === undefined) return undefined;
  const repository = json(json(data)?.["repository"]);
  return {
    labels: nodesOf(repository?.["labels"]).flatMap((each) => label(each) ?? []),
    milestones: nodesOf(repository?.["milestones"]).flatMap((each) => milestone(each) ?? []),
    me,
  };
};

// ---------------------------------------------------------------------------------------------
// Running them

const notFound = (number: number) =>
  new GitHubError({ reason: "notFound", message: `This repository has no issue #${number}.` });

/** What issues ask of GitHub. */
export type IssueGitHub = Pick<GitHub["Service"], "repository" | "graphql" | "rest">;

/** Issues of the repository `cwd`'s remotes name, through `gh`. */
export const issues = (github: IssueGitHub) => {
  const nameOf = (repository: GitHubRepository) => `${repository.owner}/${repository.name}`;
  const asked = (repository: GitHubRepository, number: number) => ({
    owner: repository.owner,
    name: repository.name,
    number,
  });

  /** The repository `cwd` works on, when it keeps issues. */
  const at = Effect.fn("Issues.at")(function* (cwd: string) {
    const repository = yield* github.repository(cwd);
    if (!repository.hasIssues) {
      return yield* new GitHubError({
        reason: "failed",
        message: `Issues are turned off for ${nameOf(repository)}.`,
      });
    }
    return repository;
  });

  const pageOf = Effect.fn("Issues.pageOf")(function* (
    repository: GitHubRepository,
    number: number,
    after: string | null,
    first: number,
  ) {
    const data = yield* github.graphql(repository.host, TIMELINE_QUERY, {
      ...asked(repository, number),
      first,
      after,
    });
    if (issueOf(data) === undefined) return yield* notFound(number);
    return parseTimelinePage(data, nameOf(repository));
  });

  /** A REST call on the issue `number`. */
  const change = Effect.fn("Issues.change")(function* (
    repository: GitHubRepository,
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ) {
    return yield* github.rest(repository.host, method, `repos/${nameOf(repository)}${path}`, body);
  });

  return {
    choices: Effect.fn("Issues.choices")(function* (cwd: string) {
      const repository = yield* github.repository(cwd);
      const data = yield* github.graphql(repository.host, CHOICES_QUERY, {
        owner: repository.owner,
        name: repository.name,
      });
      return (
        parseIssueChoices(data) ??
        (yield* new GitHubError({ reason: "signedOut", message: "GitHub didn't say who is signed in." }))
      );
    }),

    list: Effect.fn("Issues.list")(function* (cwd: string, filters: IssueFilters, after?: string) {
      const repository = yield* at(cwd);
      const data = yield* github.graphql(repository.host, LIST_QUERY, {
        q: issueSearch(nameOf(repository), filters),
        first: PAGE,
        after: after ?? null,
      });
      return parseIssuePage(data, nameOf(repository));
    }),

    /** The issue with at least `items` entries of its conversation, when it has so many. */
    detail: Effect.fn("Issues.detail")(function* (cwd: string, number: number, items: number) {
      const repository = yield* at(cwd);
      const data = yield* github.graphql(repository.host, DETAIL_QUERY, {
        ...asked(repository, number),
        first: Math.min(items, TIMELINE_PAGE),
        after: null,
      });
      const detail = parseIssueDetail(data, nameOf(repository)) ?? (yield* notFound(number));
      let timeline = detail.timeline;
      let next = nextCursor(json(issueOf(data)?.["timelineItems"]));
      while (next !== undefined && timeline.length < items) {
        const page = yield* pageOf(
          repository,
          number,
          next,
          Math.min(items - timeline.length, TIMELINE_PAGE),
        );
        timeline = [...timeline, ...page.items];
        next = page.next;
      }
      const { more: _, ...rest } = detail;
      return { ...rest, timeline, ...(next === undefined ? {} : { more: true }) } satisfies IssueDetail;
    }),

    changed: Effect.fn("Issues.changed")(function* (cwd: string, number: number, revision: string) {
      const repository = yield* at(cwd);
      const data = yield* github.graphql(repository.host, REVISION_QUERY, asked(repository, number));
      const issue = issueOf(data);
      if (issue === undefined) return yield* notFound(number);
      const now = revisionOf(issue);
      return { changed: now !== revision, revision: now };
    }),

    close: Effect.fn("Issues.close")(function* (
      cwd: string,
      number: number,
      reason: CloseReason,
      comment: string | undefined,
    ) {
      const repository = yield* at(cwd);
      // The comment goes first, so it reads as the reason for what follows.
      if (comment !== undefined && comment.trim() !== "") {
        yield* change(repository, "POST", `/issues/${number}/comments`, { body: comment });
      }
      yield* change(repository, "PATCH", `/issues/${number}`, {
        state: "closed",
        state_reason: reason === "notPlanned" ? "not_planned" : "completed",
      });
    }),

    reopen: Effect.fn("Issues.reopen")(function* (cwd: string, number: number) {
      const repository = yield* at(cwd);
      yield* change(repository, "PATCH", `/issues/${number}`, { state: "open", state_reason: "reopened" });
    }),

    update: Effect.fn("Issues.update")(function* (
      cwd: string,
      number: number,
      changes: {
        readonly addLabels?: ReadonlyArray<string> | undefined;
        readonly removeLabels?: ReadonlyArray<string> | undefined;
        readonly addAssignees?: ReadonlyArray<string> | undefined;
        readonly removeAssignees?: ReadonlyArray<string> | undefined;
      },
    ) {
      const repository = yield* at(cwd);
      const base = `/issues/${number}`;
      if ((changes.addLabels?.length ?? 0) > 0) {
        yield* change(repository, "POST", `${base}/labels`, { labels: changes.addLabels });
      }
      // A label that isn't on the issue any more is already as the user wants it.
      for (const name of changes.removeLabels ?? []) {
        yield* change(repository, "DELETE", `${base}/labels/${encodeURIComponent(name)}`).pipe(
          Effect.catchIf(
            (error) => error.reason === "notFound",
            () => Effect.void,
          ),
        );
      }
      if ((changes.addAssignees?.length ?? 0) > 0) {
        yield* change(repository, "POST", `${base}/assignees`, { assignees: changes.addAssignees });
      }
      if ((changes.removeAssignees?.length ?? 0) > 0) {
        yield* change(repository, "DELETE", `${base}/assignees`, { assignees: changes.removeAssignees });
      }
    }),

    create: Effect.fn("Issues.create")(function* (
      cwd: string,
      title: string,
      body: string,
      labels: ReadonlyArray<string> | undefined,
    ) {
      const repository = yield* at(cwd);
      const answer = json(
        yield* change(repository, "POST", "/issues", {
          title,
          body,
          ...(labels === undefined || labels.length === 0 ? {} : { labels }),
        }),
      );
      const number = whole(answer?.["number"]);
      const url = text(answer?.["html_url"]);
      if (number === undefined || url === undefined) {
        return yield* new GitHubError({
          reason: "failed",
          message: "GitHub opened the issue but didn't send it back.",
        });
      }
      return { number, url } satisfies CreatedIssue;
    }),
  };
};

/** The entries of a conversation read when the UI doesn't ask for a number. */
const DEFAULT_ITEMS = 100;

/** What the machine serves about issues. */
export const issueHandlers = (github: GitHub["Service"]) => {
  const service = issues(github);
  return IssueRpcs.of({
    IssueChoices: ({ cwd }) => service.choices(cwd),
    ListIssues: ({ cwd, filters, after }) => service.list(cwd, filters, after),
    Issue: ({ cwd, number, items }) => service.detail(cwd, number, items ?? DEFAULT_ITEMS),
    IssueChanged: ({ cwd, number, revision }) => service.changed(cwd, number, revision),
    CloseIssue: ({ cwd, number, reason, comment }) => service.close(cwd, number, reason, comment),
    ReopenIssue: ({ cwd, number }) => service.reopen(cwd, number),
    UpdateIssue: ({ cwd, number, ...changes }) => service.update(cwd, number, changes),
    CreateIssue: ({ cwd, title, body, labels }) => service.create(cwd, title, body, labels),
  });
};
