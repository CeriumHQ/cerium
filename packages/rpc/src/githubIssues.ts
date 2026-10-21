import { EpochMillis, LenientArray, withFallback } from "@cerium/protocol";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import {
  ConversationItem,
  GitHubAssociation,
  GitHubError,
  GitHubLabel,
  GitHubReaction,
  GitHubUser,
} from "./github.ts";

// What the Issues tab and the issue viewer ask of a machine about the GitHub repository of a work
// thread's folder (`cwd`); the people, labels, reactions and conversation are github.ts's, shared
// with pull requests. Times are milliseconds since the epoch.

/** Which of a repository's issues the Issues tab lists. Every filter given narrows the list. */
export const IssueFilters = Schema.Struct({
  /** Open issues when absent. */
  state: Schema.optionalKey(Schema.Literals(["open", "closed", "all"])),
  assignedToMe: Schema.optionalKey(Schema.Boolean),
  createdByMe: Schema.optionalKey(Schema.Boolean),
  mentioningMe: Schema.optionalKey(Schema.Boolean),
  /** Issues that carry every one of these labels. */
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Issues in the milestone with this title. */
  milestone: Schema.optionalKey(Schema.String),
  /** Issues in no milestone at all; `milestone` wins when both are given. */
  noMilestone: Schema.optionalKey(Schema.Boolean),
  /** Words to find in titles, bodies and comments, in GitHub's own search syntax. */
  search: Schema.optionalKey(Schema.String),
});
export type IssueFilters = typeof IssueFilters.Type;

export const IssueState = Schema.Literals(["open", "closed"]);
export type IssueState = typeof IssueState.Type;

/** Why an issue was closed. */
export const IssueStateReason = withFallback(
  Schema.Literals(["completed", "notPlanned", "duplicate"]),
  "completed",
);
export type IssueStateReason = typeof IssueStateReason.Type;

/** A pull request that closes or links an issue. */
export const LinkedPullRequest = Schema.Struct({
  number: Schema.Int,
  title: Schema.optionalKey(Schema.String),
  state: withFallback(Schema.Literals(["open", "closed", "merged"]), "open"),
  draft: Schema.optionalKey(Schema.Boolean),
  url: Schema.String,
  /** `owner/name` when it isn't in the issue's own repository. */
  repository: Schema.optionalKey(Schema.String),
});
export type LinkedPullRequest = typeof LinkedPullRequest.Type;

/** An issue as the Issues tab lists it. */
export const IssueSummary = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  state: withFallback(IssueState, "open"),
  stateReason: Schema.optionalKey(IssueStateReason),
  url: Schema.String,
  author: Schema.optionalKey(GitHubUser),
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
  comments: Schema.Int,
  labels: LenientArray(GitHubLabel),
  assignees: LenientArray(GitHubUser),
  milestone: Schema.optionalKey(Schema.String),
  pullRequests: LenientArray(LinkedPullRequest),
});
export type IssueSummary = typeof IssueSummary.Type;

/** A page of issues, most recently updated first. */
export const IssuePage = Schema.Struct({
  issues: LenientArray(IssueSummary),
  /** How many issues match, all pages together. */
  total: Schema.Int,
  /** Asks for the page after this one; none on the last. */
  next: Schema.optionalKey(Schema.String),
});
export type IssuePage = typeof IssuePage.Type;

export const IssueMilestone = Schema.Struct({
  title: Schema.String,
  url: Schema.optionalKey(Schema.String),
  /** The day it is due, as a time. */
  dueOn: Schema.optionalKey(EpochMillis),
  open: Schema.Boolean,
});
export type IssueMilestone = typeof IssueMilestone.Type;

/** A branch made for an issue. */
export const IssueBranch = Schema.Struct({
  name: Schema.NonEmptyString,
  /** `owner/name` when it isn't in the issue's own repository. */
  repository: Schema.optionalKey(Schema.String),
});
export type IssueBranch = typeof IssueBranch.Type;

/** An issue with everything the viewer shows above its conversation. */
export const IssueDetail = Schema.Struct({
  ...IssueSummary.fields,
  /** GraphQL's id, for actions that need one. */
  id: Schema.NonEmptyString,
  /** The issue's own text, Markdown. */
  body: Schema.String,
  association: Schema.optionalKey(GitHubAssociation),
  /** When its author last changed its text. */
  edited: Schema.optionalKey(EpochMillis),
  closedAt: Schema.optionalKey(EpochMillis),
  locked: Schema.Boolean,
  reactions: LenientArray(GitHubReaction),
  milestoneDetail: Schema.optionalKey(IssueMilestone),
  branches: LenientArray(IssueBranch),
  /** The signed-in user may close and reopen it: they opened it, or can write to the repository. */
  canUpdate: Schema.Boolean,
  /** The conversation from the start, as many entries as were asked for. */
  timeline: LenientArray(ConversationItem),
  /** The conversation goes on past `timeline`: ask for more `items`. */
  more: Schema.optionalKey(Schema.Boolean),
  /** Tells `IssueChanged` whether the issue changed since this reading. */
  revision: Schema.String,
});
export type IssueDetail = typeof IssueDetail.Type;

/** The labels and milestones a repository offers, for the filters and for changing an issue's labels. */
export const IssueChoices = Schema.Struct({
  labels: LenientArray(GitHubLabel),
  milestones: LenientArray(IssueMilestone),
  /** The signed-in user. */
  me: GitHubUser,
});
export type IssueChoices = typeof IssueChoices.Type;

/** What closes an issue. */
export const CloseReason = Schema.Literals(["completed", "notPlanned"]);
export type CloseReason = typeof CloseReason.Type;

/** An issue just opened. */
export const CreatedIssue = Schema.Struct({
  number: Schema.Int,
  url: Schema.String,
});
export type CreatedIssue = typeof CreatedIssue.Type;

const cwd = Schema.NonEmptyString;
const number = Schema.Int.check(Schema.isGreaterThan(0));
/** The most entries of an issue's conversation one reading holds. */
export const MAX_ISSUE_ITEMS = 500;
/** GitHub's limit for an issue's title. */
export const MAX_ISSUE_TITLE = 256;
/** GitHub's limit for the text of an issue or comment. */
export const MAX_ISSUE_BODY = 65_536;

/**
 * What the Issues tab and the issue viewer ask of a machine, merged into `MachineRpcs`. Commenting is
 * `AddGitHubComment`'s, for pull requests and issues alike.
 */
export const IssueRpcs = RpcGroup.make(
  /** The labels and milestones to filter by and to label with, and who is signed in. */
  Rpc.make("IssueChoices", { payload: { cwd }, success: IssueChoices, error: GitHubError }),
  /** A page of issues, most recently updated first; `after` is the previous page's `next`. */
  Rpc.make("ListIssues", {
    payload: { cwd, filters: IssueFilters, after: Schema.optionalKey(Schema.String) },
    success: IssuePage,
    error: GitHubError,
  }),
  /**
   * One issue with the first `items` entries of its conversation (100 when absent, at most 500); ask
   * for more as the user reads on.
   */
  Rpc.make("Issue", {
    payload: {
      cwd,
      number,
      items: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_ISSUE_ITEMS }))),
    },
    success: IssueDetail,
    error: GitHubError,
  }),
  /**
   * Whether an issue changed since the reading whose `revision` is given: a cheap poll. It doesn't see
   * a comment's text or reactions change, so read the issue again now and then.
   */
  Rpc.make("IssueChanged", {
    payload: { cwd, number, revision: Schema.String },
    success: Schema.Struct({ changed: Schema.Boolean, revision: Schema.String }),
    error: GitHubError,
  }),
  /** Closes an issue for this reason, with a comment first when one is given. */
  Rpc.make("CloseIssue", {
    payload: {
      cwd,
      number,
      reason: CloseReason,
      comment: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_ISSUE_BODY))),
    },
    error: GitHubError,
  }),
  Rpc.make("ReopenIssue", { payload: { cwd, number }, error: GitHubError }),
  /** Adds and removes labels (by name) and assignees (by login) in one go. */
  Rpc.make("UpdateIssue", {
    payload: {
      cwd,
      number,
      addLabels: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
      removeLabels: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
      addAssignees: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
      removeAssignees: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
    },
    error: GitHubError,
  }),
  /** Opens an issue in the repository. */
  Rpc.make("CreateIssue", {
    payload: {
      cwd,
      title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ISSUE_TITLE)),
      body: Schema.String.check(Schema.isMaxLength(MAX_ISSUE_BODY)),
      labels: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
    },
    success: CreatedIssue,
    error: GitHubError,
  }),
  /**
   * An issue written up from the user's notes, its `title` and `body` so far, by the quick model that
   * titles threads, in the repository's issue template. Since `RPC_VERSION` 19.
   */
  Rpc.make("DraftIssue", {
    payload: {
      cwd,
      title: Schema.String.check(Schema.isMaxLength(MAX_ISSUE_TITLE)),
      body: Schema.String.check(Schema.isMaxLength(MAX_ISSUE_BODY)),
    },
    success: Schema.Struct({ title: Schema.String, body: Schema.String }),
    error: GitHubError,
  }),
);
