import {
  GitHubError,
  GitHubRpcs,
  type BranchPullRequest,
  type ChangedFile,
  type ChecksState,
  type CheckState,
  type ConversationItem,
  type ConversationPage,
  type GitHubRepository,
  type Mergeable,
  type PullRequestCheck,
  type PullRequestChecks,
  type PullRequestCommit,
  type PullRequestCommits,
  type PullRequestDetail,
  type PullRequestFilters,
  type PullRequestPage,
  type PullRequestState,
  type PullRequestSummary,
  type ReviewComment,
  type ReviewDecision,
  type Reviewer,
  type ReviewThread,
} from "@cerium/rpc";
import { Effect } from "effect";

import { parseDiff } from "./files.ts";
import { parseRemotes, type GitHub } from "./github.ts";
import {
  ACTOR,
  association,
  commentOf,
  commitOf,
  flag,
  json,
  label,
  LABEL,
  nextCursor,
  nodesOf,
  parseConversation,
  PULL_REQUEST_TIMELINE_FIELDS,
  PULL_REQUEST_TIMELINE_TYPES,
  REACTIONS,
  reactions,
  reviewState,
  SHARED_TIMELINE_FIELDS,
  SHARED_TIMELINE_TYPES,
  text,
  time,
  user,
  whole,
  type Json,
} from "./githubConversation.ts";

// What the Pull requests tab and the pull request viewer need from GitHub: a repository's pull
// requests as a search a page at a time, one with its conversation, commits, checks and files, and
// the actions on it. The functions that don't run `gh` are plain, so they can be tested against real
// answers.

/** Pull requests a page of the list holds. */
const PAGE = 30;
/** Entries of a conversation a page holds. */
const TIMELINE_PAGE = 100;
/** Pages of changed files read at most: GitHub lists 3,000 files of a pull request, a hundred a page. */
const MAX_FILE_PAGES = 30;

// ---------------------------------------------------------------------------------------------
// Searching

/** Qualifiers of the user's own words that would leave the repository or the pull requests. */
const FOREIGN_QUALIFIER = /^-?(?:repo|org|user|type|is:issue|in:issue):?/i;

/** Whether the user's words choose a state themselves. */
const STATE_QUALIFIER = /(?:^|\s)-?is:(?:open|closed|merged|unmerged)\b/i;

/**
 * The words of GitHub's search for the pull requests of `repository` (`owner/name`) that `filters`
 * ask for, most recently updated first. The user's own words are kept as they typed them, except for
 * qualifiers that would search somewhere else.
 */
export const pullRequestSearch = (repository: string, filters: PullRequestFilters): string => {
  const own = (filters.search ?? "")
    .split(/\s+/)
    .filter((word) => word !== "" && !FOREIGN_QUALIFIER.test(word))
    .join(" ");
  const parts = [`repo:${repository}`, "is:pr"];
  const state = filters.state ?? "open";
  if (!STATE_QUALIFIER.test(own)) {
    if (state === "open") parts.push("is:open");
    else if (state === "closed") parts.push("is:closed", "is:unmerged");
    else if (state === "merged") parts.push("is:merged");
  }
  if (filters.createdByMe === true) parts.push("author:@me");
  if (filters.reviewRequested === true) parts.push("review-requested:@me");
  if (filters.assignedToMe === true) parts.push("assignee:@me");
  if (own !== "") parts.push(own);
  if (!/(?:^|\s)sort:/i.test(own)) parts.push("sort:updated-desc");
  return parts.join(" ");
};

// ---------------------------------------------------------------------------------------------
// Queries

const ROLLUP = "commits(last: 1) { totalCount nodes { commit { oid statusCheckRollup { state } } } }";

const SUMMARY = `number title state isDraft url createdAt updatedAt additions deletions
  author { ${ACTOR} }
  headRefName baseRefName
  labels(first: 10) { nodes { ${LABEL} } }
  comments { totalCount }
  reviewDecision mergeable
  ${ROLLUP}`;

export const LIST_QUERY = `query($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${SUMMARY} } }
  }
}`;

const TIMELINE = `timelineItems(first: $first, after: $after, itemTypes: [${[
  ...SHARED_TIMELINE_TYPES,
  ...PULL_REQUEST_TIMELINE_TYPES,
].join(", ")}]) {
  totalCount
  pageInfo { hasNextPage endCursor }
  nodes { ${SHARED_TIMELINE_FIELDS} ${PULL_REQUEST_TIMELINE_FIELDS} }
}`;

const REVIEWER_FIELDS = `__typename ... on User { ${ACTOR} } ... on Team { name } ... on Bot { ${ACTOR} } ... on Mannequin { ${ACTOR} }`;

const THREADS = `reviewThreads(first: 100) {
  nodes {
    id path line startLine originalLine diffSide isResolved isOutdated
    resolvedBy { login } viewerCanResolve viewerCanUnresolve viewerCanReply
    comments(first: 50) {
      nodes {
        id body createdAt lastEditedAt isMinimized minimizedReason authorAssociation url author { ${ACTOR} } ${REACTIONS}
        diffHunk pullRequestReview { id }
      }
    }
  }
}`;

export const DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id ${SUMMARY}
      body closedAt mergedAt lastEditedAt authorAssociation changedFiles
      mergedBy { ${ACTOR} }
      headRefOid headRepository { nameWithOwner } headRef { name }
      assignees(first: 20) { nodes { ${ACTOR} } }
      milestone { title }
      reviewRequests(first: 30) { nodes { requestedReviewer { ${REVIEWER_FIELDS} } } }
      latestReviews(first: 30) { nodes { state author { ${ACTOR} } } }
      mergeStateStatus viewerCanUpdate viewerDidAuthor
      ${REACTIONS}
      ${TIMELINE}
      ${THREADS}
    }
  }
}`;

export const TIMELINE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${TIMELINE} } }
}`;

/** What `PullRequestChanged` compares: little, so polling costs the rate limit next to nothing. */
export const REVISION_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { updatedAt headRefOid mergeable commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }
  }
}`;

export const COMMITS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { commit { oid messageHeadline messageBody committedDate url author { name user { ${ACTOR} } } statusCheckRollup { state } } }
      }
    }
  }
}`;

export const CHECKS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl startedAt completedAt title isRequired(pullRequestNumber: $number)
          checkSuite { app { name } workflowRun { workflow { name } } } }
        ... on StatusContext { context state targetUrl description createdAt isRequired(pullRequestNumber: $number) }
      } } } } } }
    }
  }
}`;

export const BRANCH_QUERY = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, first: 10, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { ${SUMMARY} headRepositoryOwner { login } }
    }
    pullRequestTemplates { filename body }
  }
}`;

const ID_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
}`;

const REPLY_MUTATION = `mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) {
    comment { id body createdAt lastEditedAt isMinimized minimizedReason authorAssociation url author { ${ACTOR} } ${REACTIONS} pullRequestReview { id } }
  }
}`;

const RESOLVE_MUTATION = `mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { id } } }`;
const UNRESOLVE_MUTATION = `mutation($thread: ID!) { unresolveReviewThread(input: { threadId: $thread }) { thread { id } } }`;
const READY_MUTATION = `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { id } } }`;
const DRAFT_MUTATION = `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { id } } }`;

// ---------------------------------------------------------------------------------------------
// Reading the answers

const STATES: Readonly<Record<string, PullRequestState>> = {
  OPEN: "open",
  CLOSED: "closed",
  MERGED: "merged",
};

const DECISIONS: Readonly<Record<string, ReviewDecision>> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changesRequested",
  REVIEW_REQUIRED: "reviewRequired",
};

const MERGEABLE: Readonly<Record<string, Mergeable>> = {
  MERGEABLE: "mergeable",
  CONFLICTING: "conflicting",
  UNKNOWN: "unknown",
};

/** A status rollup's state as the list shows it. */
export const checksOf = (rollup: unknown): ChecksState | undefined => {
  const state = text(json(rollup)?.["state"]);
  if (state === undefined) return undefined;
  if (state === "SUCCESS") return "passing";
  if (state === "FAILURE" || state === "ERROR") return "failing";
  return "pending";
};

/** The latest commit of a `commits(last: 1)` connection. */
const latestCommit = (pullRequest: Json) => json(nodesOf(pullRequest["commits"])[0]?.["commit"]);

export const summaryOf = (node: Json): PullRequestSummary | undefined => {
  const number = whole(node["number"]);
  const url = text(node["url"]);
  const createdAt = time(node["createdAt"]);
  if (number === undefined || url === undefined || createdAt === undefined) return undefined;
  const author = user(node["author"]);
  const decision = DECISIONS[text(node["reviewDecision"]) ?? ""];
  const checks = checksOf(latestCommit(node)?.["statusCheckRollup"]);
  return {
    number,
    title: text(node["title"]) ?? "",
    state: STATES[text(node["state"]) ?? ""] ?? "open",
    draft: flag(node["isDraft"]),
    url,
    ...(author === undefined ? {} : { author }),
    createdAt,
    updatedAt: time(node["updatedAt"]) ?? createdAt,
    head: text(node["headRefName"]) ?? "",
    base: text(node["baseRefName"]) ?? "",
    labels: nodesOf(node["labels"]).flatMap((each) => label(each) ?? []),
    comments: whole(json(node["comments"])?.["totalCount"]) ?? 0,
    ...(decision === undefined ? {} : { reviewDecision: decision }),
    mergeable: MERGEABLE[text(node["mergeable"]) ?? ""] ?? "unknown",
    ...(checks === undefined ? {} : { checks }),
    additions: whole(node["additions"]) ?? 0,
    deletions: whole(node["deletions"]) ?? 0,
  };
};

/** A page of `LIST_QUERY`'s `data`. */
export const parsePullRequestPage = (data: unknown): PullRequestPage => {
  const search = json(json(data)?.["search"]);
  const pullRequests = nodesOf(search).flatMap((each) => summaryOf(each) ?? []);
  const next = nextCursor(search);
  return {
    pullRequests,
    total: whole(search?.["issueCount"]) ?? pullRequests.length,
    ...(next === undefined ? {} : { next }),
  };
};

const pullRequestOf = (data: unknown): Json | undefined =>
  json(json(json(data)?.["repository"])?.["pullRequest"]);

/** Who was asked to review and where each review stands, those asked first. */
export const reviewersOf = (
  requests: unknown,
  latest: unknown,
  author: string | undefined,
): ReadonlyArray<Reviewer> => {
  const reviewers: Array<Reviewer> = [];
  for (const node of nodesOf(requests)) {
    const reviewer = json(node["requestedReviewer"]);
    const login = text(reviewer?.["login"]);
    const team = text(reviewer?.["name"]);
    const avatarUrl = text(reviewer?.["avatarUrl"]);
    const name = login ?? team;
    if (name === undefined) continue;
    reviewers.push({
      name,
      ...(avatarUrl === undefined ? {} : { avatarUrl }),
      ...(login === undefined ? { team: true } : {}),
      state: "requested",
    });
  }
  for (const node of nodesOf(latest)) {
    const who = user(node["author"]);
    // An author's replies to their own pull request are reviews only in GitHub's bookkeeping.
    if (who === undefined || who.login === author) continue;
    if (reviewers.some((each) => each.name === who.login)) continue;
    const state = reviewState(node["state"]);
    if (state === "pending") continue;
    reviewers.push({
      name: who.login,
      ...(who.avatarUrl === undefined ? {} : { avatarUrl: who.avatarUrl }),
      state,
    });
  }
  return reviewers;
};

/** A review thread's comment, with the review it was written in. */
const reviewCommentOf = (node: Json): ReviewComment | undefined => {
  const at = time(node["createdAt"]);
  const comment = at === undefined ? undefined : commentOf(node, at);
  if (comment === undefined) return undefined;
  const review = text(json(node["pullRequestReview"])?.["id"]);
  return { ...comment, ...(review === undefined ? {} : { review }) };
};

export const threadOf = (node: Json): ReviewThread | undefined => {
  const id = text(node["id"]);
  const path = text(node["path"]);
  if (id === undefined || path === undefined) return undefined;
  const commentNodes = nodesOf(node["comments"]);
  const comments = commentNodes.flatMap((each) => reviewCommentOf(each) ?? []);
  if (comments.length === 0) return undefined;
  const hunkText = text(commentNodes[0]?.["diffHunk"]);
  const hunk = hunkText === undefined ? undefined : parseDiff(hunkText).hunks[0];
  const line = whole(node["line"]);
  const startLine = whole(node["startLine"]);
  const originalLine = whole(node["originalLine"]);
  const resolvedBy = text(json(node["resolvedBy"])?.["login"]);
  const resolved = flag(node["isResolved"]);
  const review = comments[0]!.review;
  return {
    id,
    path,
    side: node["diffSide"] === "LEFT" ? "old" : "new",
    ...(line === undefined ? {} : { line }),
    ...(startLine === undefined || startLine === line ? {} : { startLine }),
    ...(originalLine === undefined ? {} : { originalLine }),
    ...(hunk === undefined ? {} : { hunk }),
    resolved,
    outdated: flag(node["isOutdated"]),
    ...(resolvedBy === undefined ? {} : { resolvedBy }),
    canResolve: resolved ? flag(node["viewerCanUnresolve"]) : flag(node["viewerCanResolve"]),
    canReply: flag(node["viewerCanReply"]),
    ...(review === undefined ? {} : { review }),
    comments,
  };
};

/** The revision `PullRequestChanged` compares, from its own answer or the detail's. */
export const revisionOf = (pullRequest: Json): string =>
  [
    text(pullRequest["updatedAt"]) ?? "",
    text(pullRequest["headRefOid"]) ?? "",
    text(pullRequest["mergeable"]) ?? "",
    text(json(latestCommit(pullRequest)?.["statusCheckRollup"])?.["state"]) ?? "",
  ].join("|");

/** The conversation of a page of `timelineItems`; an author's empty comment-only reviews (replies) drop out. */
const timelineOf = (connection: unknown, own: string, threads: ReadonlyArray<ReviewThread>) =>
  parseConversation(nodesOf(connection), own).filter(
    (item) =>
      item._tag !== "Review" ||
      item.state !== "commented" ||
      item.body.trim() !== "" ||
      threads.some((thread) => thread.review === item.id),
  );

/** `DETAIL_QUERY`'s `data`; none when the repository has no such pull request. */
export const parsePullRequestDetail = (data: unknown, own: string): PullRequestDetail | undefined => {
  const pullRequest = pullRequestOf(data);
  if (pullRequest === undefined) return undefined;
  const head = summaryOf(pullRequest);
  const id = text(pullRequest["id"]);
  if (head === undefined || id === undefined) return undefined;
  const standing = association(pullRequest["authorAssociation"]);
  const edited = time(pullRequest["lastEditedAt"]);
  const closedAt = time(pullRequest["closedAt"]);
  const mergedAt = time(pullRequest["mergedAt"]);
  const mergedBy = user(pullRequest["mergedBy"]);
  const headRepository = text(json(pullRequest["headRepository"])?.["nameWithOwner"]);
  const milestone = text(json(pullRequest["milestone"])?.["title"]);
  const mergeState = text(pullRequest["mergeStateStatus"])?.toLowerCase();
  const threads = nodesOf(json(pullRequest["reviewThreads"])).flatMap((each) => threadOf(each) ?? []);
  const timeline = json(pullRequest["timelineItems"]);
  const items = timelineOf(timeline, own, threads);
  const next = nextCursor(timeline);
  return {
    ...head,
    id,
    body: text(pullRequest["body"]) ?? "",
    ...(standing === undefined ? {} : { association: standing }),
    ...(edited === undefined ? {} : { edited }),
    reactions: reactions(pullRequest["reactionGroups"]),
    ...(closedAt === undefined ? {} : { closedAt }),
    ...(mergedAt === undefined ? {} : { mergedAt }),
    ...(mergedBy === undefined ? {} : { mergedBy }),
    headOid: text(pullRequest["headRefOid"]) ?? "",
    ...(headRepository === undefined || headRepository.toLowerCase() === own.toLowerCase()
      ? {}
      : { headRepository }),
    headExists: json(pullRequest["headRef"]) !== undefined,
    assignees: nodesOf(pullRequest["assignees"]).flatMap((each) => user(each) ?? []),
    reviewers: reviewersOf(pullRequest["reviewRequests"], pullRequest["latestReviews"], head.author?.login),
    ...(milestone === undefined ? {} : { milestone }),
    changedFiles: whole(pullRequest["changedFiles"]) ?? 0,
    commitCount: whole(json(pullRequest["commits"])?.["totalCount"]) ?? 0,
    ...(mergeState === undefined ? {} : { mergeState }),
    canUpdate: flag(pullRequest["viewerCanUpdate"]),
    mine: flag(pullRequest["viewerDidAuthor"]),
    timeline: items,
    timelineTotal: whole(timeline?.["totalCount"]) ?? items.length,
    ...(next === undefined ? {} : { timelineNext: next }),
    threads,
    revision: revisionOf(pullRequest),
  };
};

export const parseTimelinePage = (data: unknown, own: string): ConversationPage => {
  const timeline = json(pullRequestOf(data)?.["timelineItems"]);
  const next = nextCursor(timeline);
  // The threads came with the first page; a later page's reviews keep whatever they say.
  return {
    items: parseConversation(nodesOf(timeline), own),
    ...(next === undefined ? {} : { next }),
  };
};

export const parseCommits = (data: unknown): PullRequestCommits => {
  const connection = json(pullRequestOf(data)?.["commits"]);
  const commits = nodesOf(connection).flatMap((node): ReadonlyArray<PullRequestCommit> => {
    const commit = json(node["commit"]);
    const each = commitOf(commit);
    if (each === undefined) return [];
    const body = text(commit?.["messageBody"])?.trim();
    const checks = checksOf(commit?.["statusCheckRollup"]);
    return [
      {
        ...each,
        ...(body === undefined || body === "" ? {} : { body }),
        ...(checks === undefined ? {} : { checks }),
      },
    ];
  });
  const next = nextCursor(connection);
  return { commits, ...(next === undefined ? {} : { next }) };
};

const CONCLUSIONS: Readonly<Record<string, CheckState>> = {
  SUCCESS: "success",
  FAILURE: "failure",
  TIMED_OUT: "failure",
  STARTUP_FAILURE: "failure",
  CANCELLED: "cancelled",
  NEUTRAL: "neutral",
  SKIPPED: "skipped",
  STALE: "skipped",
  ACTION_REQUIRED: "actionRequired",
};

const STATUS_STATES: Readonly<Record<string, CheckState>> = {
  SUCCESS: "success",
  FAILURE: "failure",
  ERROR: "failure",
  PENDING: "pending",
  EXPECTED: "pending",
};

/** Failures first, then what's running, then the rest; each group by name. */
const CHECK_ORDER: ReadonlyArray<CheckState> = [
  "failure",
  "actionRequired",
  "pending",
  "cancelled",
  "success",
  "neutral",
  "skipped",
];

export const checkOf = (node: Json): PullRequestCheck | undefined => {
  if (node["__typename"] === "CheckRun") {
    const name = text(node["name"]);
    if (name === undefined) return undefined;
    const suite = json(node["checkSuite"]);
    const group =
      text(json(json(json(suite?.["workflowRun"])?.["workflow"]))?.["name"]) ??
      text(json(suite?.["app"])?.["name"]);
    const state =
      text(node["status"]) === "COMPLETED"
        ? (CONCLUSIONS[text(node["conclusion"]) ?? ""] ?? "neutral")
        : "pending";
    const description = text(node["title"]);
    const url = text(node["detailsUrl"]);
    const startedAt = time(node["startedAt"]);
    const completedAt = time(node["completedAt"]);
    return {
      name,
      ...(group === undefined ? {} : { group }),
      state,
      ...(description === undefined || description === "" ? {} : { description }),
      ...(url === undefined ? {} : { url }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(completedAt === undefined || state === "pending" ? {} : { completedAt }),
      required: flag(node["isRequired"]),
    };
  }
  if (node["__typename"] === "StatusContext") {
    const name = text(node["context"]);
    if (name === undefined) return undefined;
    const description = text(node["description"]);
    const url = text(node["targetUrl"]);
    const startedAt = time(node["createdAt"]);
    return {
      name,
      state: STATUS_STATES[text(node["state"]) ?? ""] ?? "pending",
      ...(description === undefined || description === "" ? {} : { description }),
      ...(url === undefined ? {} : { url }),
      ...(startedAt === undefined ? {} : { startedAt }),
      required: flag(node["isRequired"]),
    };
  }
  return undefined;
};

export const parseChecks = (data: unknown): PullRequestChecks => {
  const rollup = json(
    json(nodesOf(json(pullRequestOf(data)?.["commits"]))[0]?.["commit"])?.["statusCheckRollup"],
  );
  const state = checksOf(rollup);
  const checks = nodesOf(json(rollup?.["contexts"]))
    .flatMap((each) => checkOf(each) ?? [])
    .toSorted(
      (a, b) =>
        CHECK_ORDER.indexOf(a.state) - CHECK_ORDER.indexOf(b.state) ||
        (a.group ?? "").localeCompare(b.group ?? "") ||
        a.name.localeCompare(b.name),
    );
  return { ...(state === undefined ? {} : { state }), checks };
};

const FILE_STATUSES: Readonly<Record<string, ChangedFile["status"]>> = {
  added: "added",
  removed: "removed",
  modified: "modified",
  renamed: "renamed",
  copied: "copied",
  changed: "changed",
  unchanged: "changed",
};

/** A file of REST's `pulls/{n}/files`, with its patch as hunks. */
export const changedFileOf = (value: unknown): ChangedFile | undefined => {
  const file = json(value);
  const path = text(file?.["filename"]);
  if (file === undefined || path === undefined || path === "") return undefined;
  const from = text(file["previous_filename"]);
  const patch = text(file["patch"]);
  const hunks = patch === undefined ? [] : parseDiff(patch).hunks;
  const additions = whole(file["additions"]) ?? 0;
  const deletions = whole(file["deletions"]) ?? 0;
  return {
    path,
    ...(from === undefined || from === path ? {} : { from }),
    status: FILE_STATUSES[text(file["status"]) ?? ""] ?? "modified",
    additions,
    deletions,
    hunks,
    // A rename alone has no lines to show; a change GitHub left out does.
    ...(patch === undefined && additions + deletions > 0 ? { noDiff: true } : {}),
  };
};

/** A REST comment (`issues/{n}/comments`) as the conversation shows it. */
export const restCommentOf = (value: unknown): ConversationItem | undefined => {
  const comment = json(value);
  const id = text(comment?.["node_id"]);
  const at = time(comment?.["created_at"]);
  if (comment === undefined || id === undefined || at === undefined) return undefined;
  const author = json(comment["user"]);
  const login = text(author?.["login"]);
  const avatarUrl = text(author?.["avatar_url"]);
  const standing = association(comment["author_association"]);
  const url = text(comment["html_url"]);
  return {
    _tag: "Comment",
    id,
    ...(login === undefined ? {} : { author: { login, ...(avatarUrl === undefined ? {} : { avatarUrl }) } }),
    body: text(comment["body"]) ?? "",
    at,
    ...(standing === undefined ? {} : { association: standing }),
    reactions: [],
    ...(url === undefined ? {} : { url }),
  };
};

/** A pull request REST made (`POST pulls`), as the list shows it. */
export const restPullRequestOf = (value: unknown): PullRequestSummary | undefined => {
  const pull = json(value);
  const number = whole(pull?.["number"]);
  const url = text(pull?.["html_url"]);
  const createdAt = time(pull?.["created_at"]);
  if (pull === undefined || number === undefined || url === undefined || createdAt === undefined)
    return undefined;
  const author = json(pull["user"]);
  const login = text(author?.["login"]);
  const avatarUrl = text(author?.["avatar_url"]);
  return {
    number,
    title: text(pull["title"]) ?? "",
    state: "open",
    draft: flag(pull["draft"]),
    url,
    ...(login === undefined ? {} : { author: { login, ...(avatarUrl === undefined ? {} : { avatarUrl }) } }),
    createdAt,
    updatedAt: time(pull["updated_at"]) ?? createdAt,
    head: text(json(pull["head"])?.["ref"]) ?? "",
    base: text(json(pull["base"])?.["ref"]) ?? "",
    labels: [],
    comments: 0,
    mergeable: "unknown",
    additions: whole(pull["additions"]) ?? 0,
    deletions: whole(pull["deletions"]) ?? 0,
  };
};

/**
 * The branch's pull request among `BRANCH_QUERY`'s: one from the repository it's pushed to (`owner`),
 * the open one first, else the latest.
 */
export const parseBranchPullRequest = (data: unknown, owner: string) => {
  const repository = json(json(data)?.["repository"]);
  const candidates = nodesOf(repository?.["pullRequests"]).filter(
    (node) => text(json(node["headRepositoryOwner"])?.["login"])?.toLowerCase() === owner.toLowerCase(),
  );
  const chosen = candidates.find((node) => node["state"] === "OPEN") ?? candidates[0];
  const pullRequest = chosen === undefined ? undefined : summaryOf(chosen);
  // A plain list, not a connection.
  const templates: unknown = repository?.["pullRequestTemplates"];
  const template = text(json(Array.isArray(templates) ? templates[0] : undefined)?.["body"]);
  return {
    ...(pullRequest === undefined ? {} : { pullRequest }),
    ...(template === undefined || template.trim() === "" ? {} : { template }),
  };
};

// ---------------------------------------------------------------------------------------------
// Running them

const notFound = (number: number) =>
  new GitHubError({ reason: "notFound", message: `This repository has no pull request #${number}.` });

/** Pull requests of the repository `cwd`'s remotes name, through `gh`. */
export const pullRequests = (github: GitHub["Service"]) => {
  const at = (cwd: string) => github.repository(cwd);
  const nameOf = (repository: GitHubRepository) => `${repository.owner}/${repository.name}`;
  const asked = (repository: GitHubRepository, number: number) => ({
    owner: repository.owner,
    name: repository.name,
    number,
  });

  const nodeId = Effect.fn("PullRequests.nodeId")(function* (repository: GitHubRepository, number: number) {
    const data = yield* github.graphql(repository.host, ID_QUERY, asked(repository, number));
    const id = text(pullRequestOf(data)?.["id"]);
    return id === undefined ? yield* notFound(number) : id;
  });

  /** The branch checked out in `cwd`; none when detached. */
  const branchIn = Effect.fn("PullRequests.branchIn")(function* (cwd: string) {
    const { stdout, code } = yield* github.git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = stdout.trim();
    return code !== 0 || branch === "" || branch === "HEAD" ? undefined : branch;
  });

  /** The remote that pushes to the repository's fork, or to the repository itself. */
  const pushRemote = Effect.fn("PullRequests.pushRemote")(function* (
    cwd: string,
    repository: GitHubRepository,
  ) {
    const { stdout } = yield* github.git(cwd, ["remote", "-v"]);
    const target = (repository.fork ?? nameOf(repository)).toLowerCase();
    const remotes = parseRemotes(stdout);
    const remote =
      remotes.find((each) => `${each.repository.owner}/${each.repository.name}`.toLowerCase() === target) ??
      remotes.find((each) => each.name === "origin");
    return remote?.name ?? "origin";
  });

  /** How far the branch is ahead of its upstream; undefined without one. */
  const aheadOfUpstream = Effect.fn("PullRequests.aheadOfUpstream")(function* (cwd: string) {
    const upstream = yield* github.git(cwd, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
    if (upstream.code !== 0) return undefined;
    const counted = yield* github.git(cwd, ["rev-list", "--count", "@{upstream}..HEAD"]);
    return Number(counted.stdout.trim()) || 0;
  });

  /** Pushes the branch checked out in `cwd`, setting its upstream when it has none. */
  const push = Effect.fn("PullRequests.push")(function* (
    cwd: string,
    repository: GitHubRepository,
    branch: string,
  ) {
    const ahead = yield* aheadOfUpstream(cwd);
    if (ahead === 0) return;
    const args =
      ahead === undefined
        ? ["push", "--set-upstream", yield* pushRemote(cwd, repository), `HEAD:refs/heads/${branch}`]
        : ["push"];
    const pushed = yield* github.git(cwd, args);
    if (pushed.code !== 0) {
      const said = pushed.stderr
        .split("\n")
        .map((line) => line.trim())
        .findLast((line) => /^(fatal|error|remote):/.test(line));
      return yield* new GitHubError({
        reason: "failed",
        message: `The branch couldn't be pushed${said === undefined ? "." : `: ${said.replace(/^(fatal|error|remote):\s*/, "")}`}`,
      });
    }
  });

  return {
    list: Effect.fn("PullRequests.list")(function* (
      cwd: string,
      filters: PullRequestFilters,
      after?: string,
    ) {
      const repository = yield* at(cwd);
      const data = yield* github.graphql(repository.host, LIST_QUERY, {
        q: pullRequestSearch(nameOf(repository), filters),
        first: PAGE,
        after: after ?? null,
      });
      return parsePullRequestPage(data);
    }),

    detail: Effect.fn("PullRequests.detail")(function* (cwd: string, number: number) {
      const repository = yield* at(cwd);
      const data = yield* github.graphql(repository.host, DETAIL_QUERY, {
        ...asked(repository, number),
        first: TIMELINE_PAGE,
        after: null,
      });
      return parsePullRequestDetail(data, nameOf(repository)) ?? (yield* notFound(number));
    }),

    timeline: Effect.fn("PullRequests.timeline")(function* (cwd: string, number: number, after: string) {
      const repository = yield* at(cwd);
      const data = yield* github.graphql(repository.host, TIMELINE_QUERY, {
        ...asked(repository, number),
        first: TIMELINE_PAGE,
        after,
      });
      return parseTimelinePage(data, nameOf(repository));
    }),

    changed: Effect.fn("PullRequests.changed")(function* (cwd: string, number: number, revision: string) {
      const repository = yield* at(cwd);
      const data = yield* github.graphql(repository.host, REVISION_QUERY, asked(repository, number));
      const pullRequest = pullRequestOf(data);
      if (pullRequest === undefined) return yield* notFound(number);
      const now = revisionOf(pullRequest);
      return { changed: now !== revision, revision: now };
    }),

    commits: Effect.fn("PullRequests.commits")(function* (cwd: string, number: number, after?: string) {
      const repository = yield* at(cwd);
      const data = yield* github.graphql(repository.host, COMMITS_QUERY, {
        ...asked(repository, number),
        after: after ?? null,
      });
      return parseCommits(data);
    }),

    checks: Effect.fn("PullRequests.checks")(function* (cwd: string, number: number) {
      const repository = yield* at(cwd);
      return parseChecks(yield* github.graphql(repository.host, CHECKS_QUERY, asked(repository, number)));
    }),

    files: Effect.fn("PullRequests.files")(function* (cwd: string, number: number) {
      const repository = yield* at(cwd);
      const files: Array<ChangedFile> = [];
      for (let page = 1; page <= MAX_FILE_PAGES; page++) {
        const answer = yield* github.rest(
          repository.host,
          "GET",
          `repos/${nameOf(repository)}/pulls/${number}/files?per_page=100&page=${page}`,
        );
        const listed = Array.isArray(answer) ? answer : [];
        files.push(...listed.flatMap((each) => changedFileOf(each) ?? []));
        if (listed.length < 100) return { files };
      }
      return { files, truncated: true };
    }),

    comment: Effect.fn("PullRequests.comment")(function* (cwd: string, number: number, body: string) {
      const repository = yield* at(cwd);
      const answer = yield* github.rest(
        repository.host,
        "POST",
        `repos/${nameOf(repository)}/issues/${number}/comments`,
        { body },
      );
      return (
        restCommentOf(answer) ??
        (yield* new GitHubError({
          reason: "failed",
          message: "GitHub took the comment but didn't send it back.",
        }))
      );
    }),

    reply: Effect.fn("PullRequests.reply")(function* (cwd: string, thread: string, body: string) {
      const repository = yield* at(cwd);
      const data = yield* github.graphql(repository.host, REPLY_MUTATION, { thread, body });
      const node = json(json(json(data)?.["addPullRequestReviewThreadReply"])?.["comment"]);
      return (
        (node === undefined ? undefined : reviewCommentOf(node)) ??
        (yield* new GitHubError({
          reason: "failed",
          message: "GitHub took the reply but didn't send it back.",
        }))
      );
    }),

    resolve: Effect.fn("PullRequests.resolve")(function* (cwd: string, thread: string, resolved: boolean) {
      const repository = yield* at(cwd);
      yield* github.graphql(repository.host, resolved ? RESOLVE_MUTATION : UNRESOLVE_MUTATION, { thread });
    }),

    review: Effect.fn("PullRequests.review")(function* (
      cwd: string,
      number: number,
      event: "comment" | "approve" | "requestChanges",
      body: string,
    ) {
      const repository = yield* at(cwd);
      if (event === "comment" && body.trim() === "") {
        return yield* new GitHubError({
          reason: "failed",
          message: "A comment review needs something written.",
        });
      }
      yield* github.rest(repository.host, "POST", `repos/${nameOf(repository)}/pulls/${number}/reviews`, {
        event: event === "comment" ? "COMMENT" : event === "approve" ? "APPROVE" : "REQUEST_CHANGES",
        ...(body.trim() === "" ? {} : { body }),
      });
    }),

    merge: Effect.fn("PullRequests.merge")(function* (
      cwd: string,
      number: number,
      method: "merge" | "squash" | "rebase",
      headOid: string,
      deleteBranch: boolean,
    ) {
      const repository = yield* at(cwd);
      const name = nameOf(repository);
      const pull = json(yield* github.rest(repository.host, "GET", `repos/${name}/pulls/${number}`));
      yield* github.rest(repository.host, "PUT", `repos/${name}/pulls/${number}/merge`, {
        merge_method: method,
        sha: headOid,
      });
      if (!deleteBranch) return;
      const head = json(pull?.["head"]);
      const branch = text(head?.["ref"]);
      const headRepository = text(json(head?.["repo"])?.["full_name"]);
      if (branch === undefined || headRepository === undefined) return;
      yield* github
        .rest(
          repository.host,
          "DELETE",
          `repos/${headRepository}/git/refs/heads/${encodeURIComponent(branch)}`,
        )
        .pipe(
          // GitHub may have deleted it already, as the repository asks.
          Effect.catchIf(
            (error) => error.reason === "notFound" || /Reference does not exist/i.test(error.message),
            () => Effect.void,
          ),
          Effect.mapError(
            (error) =>
              new GitHubError({
                reason: error.reason,
                message: `Merged, but the branch stayed: ${error.message}`,
              }),
          ),
        );
    }),

    setState: Effect.fn("PullRequests.setState")(function* (
      cwd: string,
      number: number,
      state: "open" | "closed",
    ) {
      const repository = yield* at(cwd);
      yield* github.rest(repository.host, "PATCH", `repos/${nameOf(repository)}/pulls/${number}`, { state });
    }),

    setDraft: Effect.fn("PullRequests.setDraft")(function* (cwd: string, number: number, draft: boolean) {
      const repository = yield* at(cwd);
      const id = yield* nodeId(repository, number);
      yield* github.graphql(repository.host, draft ? DRAFT_MUTATION : READY_MUTATION, { id });
    }),

    checkout: Effect.fn("PullRequests.checkout")(function* (cwd: string, number: number) {
      const repository = yield* at(cwd);
      yield* github.gh(cwd, [
        "pr",
        "checkout",
        String(number),
        "--repo",
        `${repository.host}/${nameOf(repository)}`,
      ]);
      return { branch: (yield* branchIn(cwd)) ?? "" };
    }),

    forBranch: Effect.fn("PullRequests.forBranch")(function* (cwd: string) {
      const repository = yield* at(cwd);
      const branch = yield* branchIn(cwd);
      if (branch === undefined) return { pushed: false } satisfies BranchPullRequest;
      const pushed = (yield* aheadOfUpstream(cwd)) !== undefined;
      const data = yield* github.graphql(repository.host, BRANCH_QUERY, {
        owner: repository.owner,
        name: repository.name,
        branch,
      });
      const owner = (repository.fork ?? nameOf(repository)).split("/")[0]!;
      return { branch, pushed, ...parseBranchPullRequest(data, owner) } satisfies BranchPullRequest;
    }),

    create: Effect.fn("PullRequests.create")(function* (
      cwd: string,
      title: string,
      body: string,
      base: string,
      draft: boolean,
    ) {
      const repository = yield* at(cwd);
      const branch = yield* branchIn(cwd);
      if (branch === undefined) {
        return yield* new GitHubError({
          reason: "failed",
          message: "Check out a branch to open a pull request from.",
        });
      }
      if (branch === base) {
        return yield* new GitHubError({
          reason: "failed",
          message: `This branch is ${base} itself. Pick another base.`,
        });
      }
      yield* push(cwd, repository, branch);
      const head = repository.fork === undefined ? branch : `${repository.fork.split("/")[0]}:${branch}`;
      const answer = yield* github.rest(repository.host, "POST", `repos/${nameOf(repository)}/pulls`, {
        title,
        body,
        head,
        base,
        draft,
      });
      return (
        restPullRequestOf(answer) ??
        (yield* new GitHubError({
          reason: "failed",
          message: "GitHub opened the pull request but didn't send it back.",
        }))
      );
    }),
  };
};

/** What the machine serves about GitHub and pull requests. */
export const githubHandlers = (github: GitHub["Service"]) => {
  const pulls = pullRequests(github);
  return GitHubRpcs.of({
    GitHubStatus: () => github.status,
    LoginGitHub: () => github.login(),
    GitHubRepository: ({ cwd }) => github.repository(cwd),
    AddGitHubComment: ({ cwd, number, body }) => pulls.comment(cwd, number, body),
    ListPullRequests: ({ cwd, filters, after }) => pulls.list(cwd, filters, after),
    PullRequest: ({ cwd, number }) => pulls.detail(cwd, number),
    PullRequestTimeline: ({ cwd, number, after }) => pulls.timeline(cwd, number, after),
    PullRequestChanged: ({ cwd, number, revision }) => pulls.changed(cwd, number, revision),
    PullRequestCommits: ({ cwd, number, after }) => pulls.commits(cwd, number, after),
    PullRequestChecks: ({ cwd, number }) => pulls.checks(cwd, number),
    PullRequestFiles: ({ cwd, number }) => pulls.files(cwd, number),
    ReplyToReviewThread: ({ cwd, thread, body }) => pulls.reply(cwd, thread, body),
    ResolveReviewThread: ({ cwd, thread, resolved }) => pulls.resolve(cwd, thread, resolved),
    SubmitReview: ({ cwd, number, event, body }) => pulls.review(cwd, number, event, body),
    MergePullRequest: ({ cwd, number, method, headOid, deleteBranch }) =>
      pulls.merge(cwd, number, method, headOid, deleteBranch),
    SetPullRequestState: ({ cwd, number, state }) => pulls.setState(cwd, number, state),
    SetPullRequestDraft: ({ cwd, number, draft }) => pulls.setDraft(cwd, number, draft),
    CheckoutPullRequest: ({ cwd, number }) => pulls.checkout(cwd, number),
    BranchPullRequest: ({ cwd }) => pulls.forBranch(cwd),
    CreatePullRequest: ({ cwd, title, body, base, draft }) => pulls.create(cwd, title, body, base, draft),
  });
};
