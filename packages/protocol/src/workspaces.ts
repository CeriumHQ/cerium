import { Schema } from "effect";

/** A checkout selection is independent of the conversation that uses it. */
export const WorkspaceChoice = Schema.Struct({
  path: Schema.optionalKey(Schema.NonEmptyString),
  baseRef: Schema.optionalKey(Schema.NonEmptyString),
  branch: Schema.optionalKey(Schema.NonEmptyString),
  sourceThreadId: Schema.optionalKey(Schema.NonEmptyString),
  existingBranch: Schema.optionalKey(Schema.NonEmptyString),
  pullRequestUrl: Schema.optionalKey(Schema.NonEmptyString),
});
export type WorkspaceChoice = typeof WorkspaceChoice.Type;

export const CheckoutInfo = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  branch: Schema.String,
  head: Schema.String,
  detached: Schema.Boolean,
  managed: Schema.optionalKey(Schema.Boolean),
  threads: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String, active: Schema.Boolean })),
});
export type CheckoutInfo = typeof CheckoutInfo.Type;

export const PullRequestLink = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  state: Schema.String,
  head: Schema.String,
  watching: Schema.Boolean,
  threadIds: Schema.Array(Schema.String),
  checks: Schema.String,
  review: Schema.String,
});
export type PullRequestLink = typeof PullRequestLink.Type;

export const SourceControlSnapshot = Schema.Struct({
  id: Schema.String,
  root: Schema.String,
  branch: Schema.String,
  head: Schema.String,
  baseRef: Schema.String,
  baseCommit: Schema.String,
  staged: Schema.Finite,
  unstaged: Schema.Finite,
  conflicted: Schema.Finite,
  ahead: Schema.Finite,
  behind: Schema.Finite,
  nextAction: Schema.String,
  threads: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String, active: Schema.Boolean })),
  pulls: Schema.Array(PullRequestLink),
  issues: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      title: Schema.String,
      state: Schema.String,
      threadIds: Schema.Array(Schema.String),
    }),
  ),
  preparation: Schema.String,
  dependsOnThreadId: Schema.optionalKey(Schema.String),
  baseMoved: Schema.Boolean,
});
export type SourceControlSnapshot = typeof SourceControlSnapshot.Type;

/** The UI and agent tools submit identical commands; none accepts a shell command. */
export const SourceControlCommand = Schema.Struct({
  action: Schema.Literals([
    "status",
    "list",
    "link",
    "unlink",
    "link_issue",
    "unlink_issue",
    "watch",
    "unwatch",
    "diff",
    "cleanup",
    "retry_setup",
    "move",
  ]),
  url: Schema.optionalKey(Schema.NonEmptyString),
  scope: Schema.optionalKey(Schema.Literals(["turn", "thread", "uncommitted", "branch"])),
  workspace: Schema.optionalKey(WorkspaceChoice),
  targetPath: Schema.optionalKey(Schema.NonEmptyString),
});
export type SourceControlCommand = typeof SourceControlCommand.Type;
export const SourceControlResult = Schema.Struct({
  snapshot: Schema.optionalKey(SourceControlSnapshot),
  checkouts: Schema.optionalKey(Schema.Array(CheckoutInfo)),
  diff: Schema.optionalKey(Schema.String),
  revision: Schema.optionalKey(Schema.String),
  note: Schema.String,
});
export type SourceControlResult = typeof SourceControlResult.Type;
