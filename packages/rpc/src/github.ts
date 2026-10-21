import { EpochMillis, LenientArray, VersionStatus, withFallback } from "@cerium/protocol";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { DiffHunk } from "./files.ts";

// What a machine says about GitHub for a work thread's folder (`cwd`), through the user's own `gh`:
// whether it's installed and signed in, the repository the folder's remotes name, and that
// repository's pull requests. Issues add theirs in githubIssues.ts. `gh` keeps the credential; Cerium
// never reads it. Times are milliseconds since the epoch.

// ---------------------------------------------------------------------------------------------
// The GitHub CLI

/** Why GitHub couldn't answer, for the UI to offer the fix: install `gh`, sign in, and so on. */
export const GitHubErrorReason = Schema.Literals([
  /** `gh` isn't installed on the machine. */
  "missing",
  /** `gh` isn't signed in to the repository's host, or its sign-in stopped working. */
  "signedOut",
  /** The folder isn't in a git repository with a GitHub remote. */
  "noRepository",
  /** GitHub has no such repository, pull request or issue, or the account can't see it. */
  "notFound",
  /** The account used up its requests for now. */
  "rateLimited",
  /** GitHub can't be reached. */
  "offline",
  "failed",
]);
export type GitHubErrorReason = typeof GitHubErrorReason.Type;

/** A request GitHub, or `gh`, refused; `message` is written for the user. */
export class GitHubError extends Schema.TaggedError<GitHubError>()("GitHubError", {
  reason: withFallback(GitHubErrorReason, "failed"),
  message: Schema.String,
}) {}

/** An account `gh` is signed in with. */
export const GitHubAccount = Schema.Struct({
  host: Schema.NonEmptyString,
  login: Schema.NonEmptyString,
  /** The account `gh` uses on its host. */
  active: Schema.Boolean,
  /** `gh` holds a sign-in it can't use any more: expired, revoked or unreachable. */
  failing: Schema.optionalKey(Schema.Boolean),
});
export type GitHubAccount = typeof GitHubAccount.Type;

/** The GitHub CLI on a machine. */
export const GitHubStatus = Schema.Union([
  Schema.TaggedStruct("GhMissing", { installUrl: Schema.String }),
  Schema.TaggedStruct("GhInstalled", {
    executablePath: Schema.String,
    version: Schema.String,
    versionStatus: VersionStatus,
    /** None while it isn't signed in anywhere. */
    accounts: LenientArray(GitHubAccount),
  }),
]);
export type GitHubStatus = typeof GitHubStatus.Type;

/** How `gh auth login --web` is going. */
export const GitHubLoginProgress = Schema.Union([
  /** The page to sign in on, and the one-time code it asks for. */
  Schema.TaggedStruct("Code", { code: Schema.NonEmptyString, url: Schema.NonEmptyString }),
  Schema.TaggedStruct("SignedIn", {}),
]);
export type GitHubLoginProgress = typeof GitHubLoginProgress.Type;

// ---------------------------------------------------------------------------------------------
// Repositories

export const MergeMethod = Schema.Literals(["merge", "squash", "rebase"]);
export type MergeMethod = typeof MergeMethod.Type;

/** What the signed-in account may do in a repository, least first. */
export const RepositoryPermission = withFallback(
  Schema.Literals(["none", "read", "triage", "write", "maintain", "admin"]),
  "none",
);
export type RepositoryPermission = typeof RepositoryPermission.Type;

/**
 * The GitHub repository a folder works on: where its pull requests and issues are. For a fork, that's
 * the repository it was forked from, and `fork` is the user's own.
 */
export const GitHubRepository = Schema.Struct({
  host: Schema.NonEmptyString,
  owner: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  url: Schema.String,
  defaultBranch: Schema.String,
  /** The fork the folder pushes to, as `owner/name`, when it isn't the repository itself. */
  fork: Schema.optionalKey(Schema.String),
  /** The signed-in account. */
  viewer: Schema.String,
  permission: RepositoryPermission,
  /** How pull requests may be merged, in the order GitHub's own button offers them. */
  mergeMethods: Schema.Array(MergeMethod),
  /** Merging deletes the head branch on its own. */
  deleteBranchOnMerge: Schema.Boolean,
  hasIssues: Schema.Boolean,
  private: Schema.Boolean,
});
export type GitHubRepository = typeof GitHubRepository.Type;

// ---------------------------------------------------------------------------------------------
// Conversations: a pull request's or an issue's description, comments, reviews and events

/** A person, or a bot, on GitHub. */
export const GitHubUser = Schema.Struct({
  login: Schema.NonEmptyString,
  avatarUrl: Schema.optionalKey(Schema.String),
});
export type GitHubUser = typeof GitHubUser.Type;

export const GitHubLabel = Schema.Struct({
  name: Schema.NonEmptyString,
  /** Six hex digits, without the `#`. */
  color: Schema.String,
  description: Schema.optionalKey(Schema.String),
});
export type GitHubLabel = typeof GitHubLabel.Type;

export const ReactionKind = withFallback(
  Schema.Literals(["thumbsUp", "thumbsDown", "laugh", "hooray", "confused", "heart", "rocket", "eyes"]),
  "thumbsUp",
);
export type ReactionKind = typeof ReactionKind.Type;

/** One kind of reaction something has; kinds nobody used are left out. */
export const GitHubReaction = Schema.Struct({
  kind: ReactionKind,
  count: Schema.Int,
  /** The signed-in user left it. */
  mine: Schema.Boolean,
});
export type GitHubReaction = typeof GitHubReaction.Type;

/** How the author is tied to the repository, when GitHub says. */
export const GitHubAssociation = withFallback(
  Schema.Literals(["owner", "member", "collaborator", "contributor", "firstTimer", "none"]),
  "none",
);
export type GitHubAssociation = typeof GitHubAssociation.Type;

/** Another issue or pull request an event names. */
export const GitHubReference = Schema.Struct({
  kind: withFallback(Schema.Literals(["issue", "pullRequest"]), "issue"),
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  /** `owner/name` when it isn't in the conversation's own repository. */
  repository: Schema.optionalKey(Schema.String),
});
export type GitHubReference = typeof GitHubReference.Type;

/** What a review concluded. */
export const ReviewState = withFallback(
  Schema.Literals(["approved", "changesRequested", "commented", "dismissed", "pending"]),
  "commented",
);
export type ReviewState = typeof ReviewState.Type;

/** A commit as a conversation lists it. */
export const ConversationCommit = Schema.Struct({
  oid: Schema.NonEmptyString,
  headline: Schema.String,
  /** The GitHub account that wrote it, when GitHub knows it. */
  author: Schema.optionalKey(GitHubUser),
  /** The name its author gave git. */
  authorName: Schema.optionalKey(Schema.String),
  at: EpochMillis,
  url: Schema.String,
});
export type ConversationCommit = typeof ConversationCommit.Type;

const at = EpochMillis;
const actor = Schema.optionalKey(GitHubUser);

/** A comment, or the description itself, as a conversation shows it. */
const commentFields = {
  id: Schema.NonEmptyString,
  author: actor,
  body: Schema.String,
  at,
  /** When its author last changed it. */
  edited: Schema.optionalKey(EpochMillis),
  association: Schema.optionalKey(GitHubAssociation),
  reactions: LenientArray(GitHubReaction),
  url: Schema.optionalKey(Schema.String),
  /** A moderator hid it, for this reason. */
  hidden: Schema.optionalKey(Schema.String),
};

/** One entry of a pull request's or an issue's conversation, in the order it happened. */
export const ConversationItem = Schema.Union([
  Schema.TaggedStruct("Comment", commentFields),
  /** Labels added and taken off together, by one person in one go. */
  Schema.TaggedStruct("Labels", {
    at,
    actor,
    added: LenientArray(GitHubLabel),
    removed: LenientArray(GitHubLabel),
  }),
  Schema.TaggedStruct("Assignees", {
    at,
    actor,
    added: Schema.Array(Schema.String),
    removed: Schema.Array(Schema.String),
  }),
  Schema.TaggedStruct("Closed", {
    at,
    actor,
    reason: Schema.optionalKey(
      withFallback(Schema.Literals(["completed", "notPlanned", "duplicate"]), "completed"),
    ),
    /** The pull request or commit that closed it. */
    by: Schema.optionalKey(Schema.Struct({ label: Schema.String, url: Schema.String })),
  }),
  Schema.TaggedStruct("Reopened", { at, actor }),
  Schema.TaggedStruct("Renamed", { at, actor, from: Schema.String, to: Schema.String }),
  Schema.TaggedStruct("Milestone", { at, actor, title: Schema.String, removed: Schema.Boolean }),
  Schema.TaggedStruct("Referenced", {
    at,
    actor,
    by: GitHubReference,
    /** The reference says it closes this issue. */
    closes: Schema.Boolean,
  }),
  /** A commit that mentions it. */
  Schema.TaggedStruct("Committed", {
    at,
    actor,
    oid: Schema.String,
    headline: Schema.String,
    url: Schema.String,
  }),
  Schema.TaggedStruct("Locked", {
    at,
    actor,
    locked: Schema.Boolean,
    reason: Schema.optionalKey(Schema.String),
  }),
  /** A pull request linked to or taken off the issue. */
  Schema.TaggedStruct("Linked", { at, actor, subject: GitHubReference, unlinked: Schema.Boolean }),
  Schema.TaggedStruct("Duplicate", { at, actor, of: GitHubReference }),
  Schema.TaggedStruct("Transferred", { at, actor, from: Schema.String }),
  // Pull requests only.
  /** A review, its own text; its threads are the pull request's `threads` with its `id` as `review`. */
  Schema.TaggedStruct("Review", { ...commentFields, state: ReviewState }),
  /** Commits pushed one after another, by one person. */
  Schema.TaggedStruct("Commits", { at, actor, commits: LenientArray(ConversationCommit) }),
  Schema.TaggedStruct("ReviewRequested", {
    at,
    actor,
    /** A login, or a team's name. */
    reviewer: Schema.String,
    removed: Schema.Boolean,
  }),
  Schema.TaggedStruct("Merged", { at, actor, oid: Schema.String, base: Schema.String, url: Schema.String }),
  /** Marked ready for review (`draft` false), or turned back into a draft. */
  Schema.TaggedStruct("Draft", { at, actor, draft: Schema.Boolean }),
  Schema.TaggedStruct("ForcePushed", {
    at,
    actor,
    before: Schema.optionalKey(Schema.String),
    after: Schema.optionalKey(Schema.String),
  }),
  /** The head branch was deleted, or restored. */
  Schema.TaggedStruct("Branch", { at, actor, deleted: Schema.Boolean }),
  Schema.TaggedStruct("BaseChanged", { at, actor, from: Schema.String, to: Schema.String }),
]);
export type ConversationItem = typeof ConversationItem.Type;
export type ConversationComment = Extract<ConversationItem, { readonly _tag: "Comment" }>;

// ---------------------------------------------------------------------------------------------
// Pull requests

export const PullRequestState = withFallback(Schema.Literals(["open", "closed", "merged"]), "open");
export type PullRequestState = typeof PullRequestState.Type;

/** How a pull request's checks stand as a whole. */
export const ChecksState = withFallback(Schema.Literals(["passing", "failing", "pending"]), "pending");
export type ChecksState = typeof ChecksState.Type;

export const ReviewDecision = withFallback(
  Schema.Literals(["approved", "changesRequested", "reviewRequired"]),
  "reviewRequired",
);
export type ReviewDecision = typeof ReviewDecision.Type;

/** Whether a pull request merges cleanly into its base; GitHub works it out a moment after a push. */
export const Mergeable = withFallback(Schema.Literals(["mergeable", "conflicting", "unknown"]), "unknown");
export type Mergeable = typeof Mergeable.Type;

/** Which pull requests the Pull requests tab lists; every filter given narrows the list. */
export const PullRequestFilters = Schema.Struct({
  /** Open ones when absent. */
  state: Schema.optionalKey(Schema.Literals(["open", "closed", "merged", "all"])),
  createdByMe: Schema.optionalKey(Schema.Boolean),
  /** Waiting on the signed-in user's review. */
  reviewRequested: Schema.optionalKey(Schema.Boolean),
  assignedToMe: Schema.optionalKey(Schema.Boolean),
  /** Words to find, in GitHub's own search syntax. */
  search: Schema.optionalKey(Schema.String),
});
export type PullRequestFilters = typeof PullRequestFilters.Type;

/** A pull request as the Pull requests tab lists it. */
export const PullRequestSummary = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  state: PullRequestState,
  draft: Schema.Boolean,
  url: Schema.String,
  author: actor,
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
  /** The branch it merges, and the one it merges into. */
  head: Schema.String,
  base: Schema.String,
  labels: LenientArray(GitHubLabel),
  comments: Schema.Int,
  reviewDecision: Schema.optionalKey(ReviewDecision),
  mergeable: Mergeable,
  /** Absent when it has no checks. */
  checks: Schema.optionalKey(ChecksState),
  additions: Schema.Int,
  deletions: Schema.Int,
});
export type PullRequestSummary = typeof PullRequestSummary.Type;

/** A page of pull requests, most recently updated first. */
export const PullRequestPage = Schema.Struct({
  pullRequests: LenientArray(PullRequestSummary),
  /** How many match, all pages together. */
  total: Schema.Int,
  /** Asks for the page after this one; none on the last. */
  next: Schema.optionalKey(Schema.String),
});
export type PullRequestPage = typeof PullRequestPage.Type;

/** A reviewer and where their review stands. */
export const Reviewer = Schema.Struct({
  /** A login, or a team's name. */
  name: Schema.NonEmptyString,
  avatarUrl: Schema.optionalKey(Schema.String),
  team: Schema.optionalKey(Schema.Boolean),
  /** Asked for a review not given yet, or the verdict of their latest. */
  state: withFallback(
    Schema.Literals(["requested", "approved", "changesRequested", "commented", "dismissed"]),
    "requested",
  ),
});
export type Reviewer = typeof Reviewer.Type;

/** A comment of a review thread. */
export const ReviewComment = Schema.Struct({
  ...commentFields,
  /** The review it was written in. */
  review: Schema.optionalKey(Schema.String),
});
export type ReviewComment = typeof ReviewComment.Type;

/** A conversation on lines of a pull request's diff. */
export const ReviewThread = Schema.Struct({
  id: Schema.NonEmptyString,
  path: Schema.String,
  /** The side of the diff it's on: the base's lines (`old`) or the head's. */
  side: withFallback(Schema.Literals(["old", "new"]), "new"),
  /** The line it's on, and the first line of a range, in the diff as it is now; absent once outdated. */
  line: Schema.optionalKey(Schema.Int),
  startLine: Schema.optionalKey(Schema.Int),
  /** The line it was written on, in the diff as it was then. */
  originalLine: Schema.optionalKey(Schema.Int),
  /** The diff around the line, as it was written on, ending with that line. */
  hunk: Schema.optionalKey(DiffHunk),
  resolved: Schema.Boolean,
  /** The lines changed since: it's on code the diff no longer shows. */
  outdated: Schema.Boolean,
  resolvedBy: Schema.optionalKey(Schema.String),
  canResolve: Schema.Boolean,
  canReply: Schema.Boolean,
  /** The review its first comment was written in, whose entry of the conversation shows it. */
  review: Schema.optionalKey(Schema.String),
  comments: LenientArray(ReviewComment),
});
export type ReviewThread = typeof ReviewThread.Type;

/** A pull request with everything its viewer shows above and in its conversation. */
export const PullRequestDetail = Schema.Struct({
  ...PullRequestSummary.fields,
  /** GraphQL's id, for actions that need one. */
  id: Schema.NonEmptyString,
  /** Its own text, Markdown. */
  body: Schema.String,
  association: Schema.optionalKey(GitHubAssociation),
  edited: Schema.optionalKey(EpochMillis),
  reactions: LenientArray(GitHubReaction),
  closedAt: Schema.optionalKey(EpochMillis),
  mergedAt: Schema.optionalKey(EpochMillis),
  mergedBy: actor,
  /** The head's latest commit. */
  headOid: Schema.String,
  /** The repository the head branch is in, as `owner/name`, when it isn't the base's: a fork's. Absent once deleted. */
  headRepository: Schema.optionalKey(Schema.String),
  /** The head branch is there still, to delete after a merge. */
  headExists: Schema.Boolean,
  assignees: LenientArray(GitHubUser),
  reviewers: LenientArray(Reviewer),
  milestone: Schema.optionalKey(Schema.String),
  changedFiles: Schema.Int,
  commitCount: Schema.Int,
  /** GitHub's word on what merging waits for: `clean`, `blocked`, `behind`, `unstable`, `dirty`... */
  mergeState: Schema.optionalKey(Schema.String),
  /** The signed-in user may edit it: close, reopen, mark ready. */
  canUpdate: Schema.Boolean,
  /** The signed-in user opened it, so can't approve it or ask for changes. */
  mine: Schema.Boolean,
  /** The conversation from the start, up to a page. */
  timeline: LenientArray(ConversationItem),
  timelineTotal: Schema.Int,
  /** Asks `PullRequestTimeline` for the entries after those sent; none when all were. */
  timelineNext: Schema.optionalKey(Schema.String),
  /** Every review thread, resolved or not. */
  threads: LenientArray(ReviewThread),
  /** Tells `PullRequestChanged` whether it changed since this reading. */
  revision: Schema.String,
});
export type PullRequestDetail = typeof PullRequestDetail.Type;

/** More of a pull request's conversation. */
export const ConversationPage = Schema.Struct({
  items: LenientArray(ConversationItem),
  next: Schema.optionalKey(Schema.String),
});
export type ConversationPage = typeof ConversationPage.Type;

export const PullRequestCommit = Schema.Struct({
  ...ConversationCommit.fields,
  /** The rest of its message, after the headline. */
  body: Schema.optionalKey(Schema.String),
  checks: Schema.optionalKey(ChecksState),
});
export type PullRequestCommit = typeof PullRequestCommit.Type;

export const PullRequestCommits = Schema.Struct({
  commits: LenientArray(PullRequestCommit),
  next: Schema.optionalKey(Schema.String),
});
export type PullRequestCommits = typeof PullRequestCommits.Type;

/** How one check went, or is going. */
export const CheckState = withFallback(
  Schema.Literals(["success", "failure", "pending", "skipped", "cancelled", "neutral", "actionRequired"]),
  "pending",
);
export type CheckState = typeof CheckState.Type;

/** A check run, or a commit status, on a pull request's latest commit. */
export const PullRequestCheck = Schema.Struct({
  name: Schema.String,
  /** The workflow or app that ran it. */
  group: Schema.optionalKey(Schema.String),
  state: CheckState,
  /** What it says of itself: its title, or a status's description. */
  description: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  startedAt: Schema.optionalKey(EpochMillis),
  completedAt: Schema.optionalKey(EpochMillis),
  /** Branch protection needs it to pass before a merge. */
  required: Schema.Boolean,
});
export type PullRequestCheck = typeof PullRequestCheck.Type;

export const PullRequestChecks = Schema.Struct({
  state: Schema.optionalKey(ChecksState),
  checks: LenientArray(PullRequestCheck),
});
export type PullRequestChecks = typeof PullRequestChecks.Type;

/** A file a pull request changes, with its diff against the base. */
export const ChangedFile = Schema.Struct({
  path: Schema.NonEmptyString,
  /** Where a renamed file was before. */
  from: Schema.optionalKey(Schema.String),
  status: withFallback(
    Schema.Literals(["added", "removed", "modified", "renamed", "copied", "changed"]),
    "modified",
  ),
  additions: Schema.Int,
  deletions: Schema.Int,
  hunks: Schema.Array(DiffHunk),
  /** GitHub sends no lines for it: it isn't text, or its diff is too large to show. */
  noDiff: Schema.optionalKey(Schema.Boolean),
});
export type ChangedFile = typeof ChangedFile.Type;

export const PullRequestFiles = Schema.Struct({
  files: LenientArray(ChangedFile),
  /** It changes more files than are sent. */
  truncated: Schema.optionalKey(Schema.Boolean),
});
export type PullRequestFiles = typeof PullRequestFiles.Type;

/** The branch checked out in a folder, and its pull request when it has one. */
export const BranchPullRequest = Schema.Struct({
  /** None when detached, or with no commit yet. */
  branch: Schema.optionalKey(Schema.String),
  /** Its open pull request, or else its latest. */
  pullRequest: Schema.optionalKey(PullRequestSummary),
  /** The branch is on GitHub: it has an upstream, or a branch of its name is on the remote. */
  pushed: Schema.Boolean,
  /** The repository's own pull request template, to start the description with. */
  template: Schema.optionalKey(Schema.String),
});
export type BranchPullRequest = typeof BranchPullRequest.Type;

export const ReviewEvent = Schema.Literals(["comment", "approve", "requestChanges"]);
export type ReviewEvent = typeof ReviewEvent.Type;

// ---------------------------------------------------------------------------------------------

const cwd = Schema.NonEmptyString;
const number = Schema.Int.check(Schema.isGreaterThan(0));

/** What a machine serves about GitHub and pull requests; merged into `MachineRpcs`. Since `RPC_VERSION` 16. */
export const GitHubRpcs = RpcGroup.make(
  /** The GitHub CLI on this machine, and who it's signed in as. */
  Rpc.make("GitHubStatus", { success: GitHubStatus }),
  /** Runs `gh auth login --web`. Unsubscribing cancels it; `gh` keeps the credential it gets. */
  Rpc.make("LoginGitHub", { success: GitHubLoginProgress, stream: true, error: GitHubError }),
  /** The GitHub repository `cwd`'s remotes name. */
  Rpc.make("GitHubRepository", { payload: { cwd }, success: GitHubRepository, error: GitHubError }),
  /** Comments on a pull request or an issue; answers with the comment as its conversation shows it. */
  Rpc.make("AddGitHubComment", {
    payload: { cwd, number, body: Schema.NonEmptyString },
    success: ConversationItem,
    error: GitHubError,
  }),
  /** A page of the repository's pull requests, from `after` (`next` of the page before). */
  Rpc.make("ListPullRequests", {
    payload: { cwd, filters: PullRequestFilters, after: Schema.optionalKey(Schema.String) },
    success: PullRequestPage,
    error: GitHubError,
  }),
  Rpc.make("PullRequest", { payload: { cwd, number }, success: PullRequestDetail, error: GitHubError }),
  Rpc.make("PullRequestTimeline", {
    payload: { cwd, number, after: Schema.NonEmptyString },
    success: ConversationPage,
    error: GitHubError,
  }),
  /** Whether a pull request changed since the reading whose `revision` is given: a cheap poll. */
  Rpc.make("PullRequestChanged", {
    payload: { cwd, number, revision: Schema.String },
    success: Schema.Struct({ changed: Schema.Boolean, revision: Schema.String }),
    error: GitHubError,
  }),
  Rpc.make("PullRequestCommits", {
    payload: { cwd, number, after: Schema.optionalKey(Schema.String) },
    success: PullRequestCommits,
    error: GitHubError,
  }),
  Rpc.make("PullRequestChecks", { payload: { cwd, number }, success: PullRequestChecks, error: GitHubError }),
  Rpc.make("PullRequestFiles", { payload: { cwd, number }, success: PullRequestFiles, error: GitHubError }),
  Rpc.make("ReplyToReviewThread", {
    payload: { cwd, thread: Schema.NonEmptyString, body: Schema.NonEmptyString },
    success: ReviewComment,
    error: GitHubError,
  }),
  Rpc.make("ResolveReviewThread", {
    payload: { cwd, thread: Schema.NonEmptyString, resolved: Schema.Boolean },
    error: GitHubError,
  }),
  /** Submits a review; a comment-only review needs a body. */
  Rpc.make("SubmitReview", {
    payload: { cwd, number, event: ReviewEvent, body: Schema.String },
    error: GitHubError,
  }),
  /** Merges a pull request the way asked, at the head it was read at, then deletes its branch when asked. */
  Rpc.make("MergePullRequest", {
    payload: {
      cwd,
      number,
      method: MergeMethod,
      headOid: Schema.NonEmptyString,
      deleteBranch: Schema.Boolean,
    },
    error: GitHubError,
  }),
  Rpc.make("SetPullRequestState", {
    payload: { cwd, number, state: Schema.Literals(["open", "closed"]) },
    error: GitHubError,
  }),
  /** Marks a draft ready for review, or turns a pull request back into a draft. */
  Rpc.make("SetPullRequestDraft", { payload: { cwd, number, draft: Schema.Boolean }, error: GitHubError }),
  /** Checks a pull request's branch out in `cwd`, as `gh pr checkout` does; answers with the branch. */
  Rpc.make("CheckoutPullRequest", {
    payload: { cwd, number },
    success: Schema.Struct({ branch: Schema.String }),
    error: GitHubError,
  }),
  Rpc.make("BranchPullRequest", { payload: { cwd }, success: BranchPullRequest, error: GitHubError }),
  /** Opens a pull request from the branch checked out in `cwd`, pushing it first when it isn't on GitHub. */
  Rpc.make("CreatePullRequest", {
    payload: {
      cwd,
      title: Schema.NonEmptyString,
      body: Schema.String,
      base: Schema.NonEmptyString,
      draft: Schema.Boolean,
    },
    success: PullRequestSummary,
    error: GitHubError,
  }),
);
