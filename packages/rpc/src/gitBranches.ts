import { LenientArray, withFallback } from "@cerium/protocol";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { CeriumError } from "./error.ts";

// What Source control's header asks of a machine about a work thread's folder: which branch is
// checked out and how it stands against its upstream, the branches to switch between, syncing with
// the remote, the stash, and merges (and rebases, cherry-picks) that stop on conflicts. Every `root`
// is the folder asked about, as in the file explorer's calls, and every path is relative to it with
// forward slashes (a path in another part of the repository climbs out with `../`).

/** A merge, rebase, cherry-pick or revert that git stopped halfway through. */
export const GitOperationKind = Schema.Literals(["merge", "rebase", "cherry-pick", "revert"]);
export type GitOperationKind = typeof GitOperationKind.Type;

/** What one side of a conflict did to the file. */
export const ConflictSide = Schema.Literals(["modified", "added", "deleted"]);
export type ConflictSide = typeof ConflictSide.Type;

/** A file git couldn't merge by itself. `ours` is the side checked out, `theirs` the one coming in. */
export const UnmergedFile = Schema.Struct({
  /** From the repository's top, as `GitResolve` takes it. */
  path: Schema.NonEmptyString,
  /** Where the file is relative to the folder asked about, for opening it; absent outside that folder. */
  inFolder: Schema.optionalKey(Schema.NonEmptyString),
  ours: withFallback(ConflictSide, "modified"),
  theirs: withFallback(ConflictSide, "modified"),
});
export type UnmergedFile = typeof UnmergedFile.Type;

/** How far a branch is from the branch it follows. */
export const BranchUpstream = Schema.Struct({
  /** The remote branch as git names it, such as `origin/main`. */
  name: Schema.NonEmptyString,
  /** Commits here that the remote branch lacks. */
  ahead: Schema.Int,
  /** Commits on the remote branch that are missing here. */
  behind: Schema.Int,
  /** The remote branch is gone: deleted there, or never fetched. */
  gone: Schema.Boolean,
});
export type BranchUpstream = typeof BranchUpstream.Type;

/** An operation stopped halfway, with how far it got when git says. */
export const GitOperationState = Schema.Struct({
  kind: withFallback(GitOperationKind, "merge"),
  step: Schema.optionalKey(Schema.Int),
  total: Schema.optionalKey(Schema.Int),
});
export type GitOperationState = typeof GitOperationState.Type;

/** Where a folder's repository stands: its branch, its sync with the remote, and what is unfinished. */
export const GitBranchState = Schema.Struct({
  /** The folder is in a git repository. */
  repository: Schema.Boolean,
  /** The branch checked out; absent when HEAD is detached. */
  branch: Schema.optionalKey(Schema.NonEmptyString),
  /** The commit HEAD is at, shortened; absent in a repository without commits. */
  commit: Schema.optionalKey(Schema.NonEmptyString),
  /** HEAD isn't on a branch: `commit` is what is checked out. */
  detached: Schema.optionalKey(Schema.Boolean),
  /** The branch it follows, with the distance to it; absent without one. */
  upstream: Schema.optionalKey(BranchUpstream),
  /** The remotes' names, such as `origin`. */
  remotes: Schema.Array(Schema.String),
  /** Files that differ from the last commit, untracked ones too. */
  changes: Schema.Int,
  /** Set while a merge, rebase, cherry-pick or revert waits to be continued or aborted. */
  operation: Schema.optionalKey(GitOperationState),
  /** Files with conflicts to resolve, whether or not an operation is in progress. */
  conflicts: LenientArray(UnmergedFile),
});
export type GitBranchState = typeof GitBranchState.Type;

/** A branch of the repository. */
export const LocalBranch = Schema.Struct({
  name: Schema.NonEmptyString,
  /** It is the branch checked out here. */
  current: Schema.Boolean,
  /** The branch it follows and the distance to it; absent without one. */
  upstream: Schema.optionalKey(BranchUpstream),
  /** The folder of another worktree that has it checked out: this folder can't switch to it. */
  checkedOutAt: Schema.optionalKey(Schema.NonEmptyString),
  /** When its last commit was made, in seconds since 1970. */
  committedAt: Schema.Finite,
  /** Its last commit's first line. */
  subject: Schema.String,
});
export type LocalBranch = typeof LocalBranch.Type;

/** A branch on a remote, as of the last fetch. */
export const RemoteBranch = Schema.Struct({
  /** As git names it, such as `origin/feature`. */
  name: Schema.NonEmptyString,
  remote: Schema.NonEmptyString,
  /** The local branch that follows it, when there is one. */
  local: Schema.optionalKey(Schema.NonEmptyString),
  committedAt: Schema.Finite,
  subject: Schema.String,
});
export type RemoteBranch = typeof RemoteBranch.Type;

/** The branches to switch between, most recently committed to first. */
export const GitBranchList = Schema.Struct({
  local: LenientArray(LocalBranch),
  remote: LenientArray(RemoteBranch),
  /** There are more branches than are listed. */
  truncated: Schema.optionalKey(Schema.Boolean),
});
export type GitBranchList = typeof GitBranchList.Type;

/** What an operation that changes the repository turned out to be, besides it having worked. */
export const GitOutcome = Schema.Struct({
  /** It stopped on conflicts: `GitState` lists them and the operation's controls take over. */
  conflicted: Schema.optionalKey(Schema.Boolean),
  /** There was nothing to do: already up to date, nothing to stash, nothing to push. */
  unchanged: Schema.optionalKey(Schema.Boolean),
});
export type GitOutcome = typeof GitOutcome.Type;

/** What to do with uncommitted changes when switching to another branch. */
export const SwitchChanges = Schema.Literals(["carry", "stash"]);
export type SwitchChanges = typeof SwitchChanges.Type;

/** A branch is deleted, or git won't because commits on it would be lost. */
export const GitDeleteOutcome = Schema.Union([
  Schema.TaggedStruct("Deleted", {}),
  /** The branch holds commits no other branch has; deleting it anyway needs `force`. */
  Schema.TaggedStruct("Unmerged", { commits: Schema.Int }),
]);
export type GitDeleteOutcome = typeof GitDeleteOutcome.Type;

/** What a push does. */
export const PushMode = Schema.Literals(["push", "publish", "forceWithLease"]);
export type PushMode = typeof PushMode.Type;

/** A set of changes put aside. */
export const StashEntry = Schema.Struct({
  /** Its commit's id: what the other stash calls name it by, since the order shifts. */
  commit: Schema.NonEmptyString,
  /** What the user wrote, or the commit's first line when they wrote nothing. */
  message: Schema.String,
  /** The branch it was made on. */
  branch: Schema.optionalKey(Schema.String),
  /** When it was made, in seconds since 1970. */
  at: Schema.Finite,
});
export type StashEntry = typeof StashEntry.Type;

/** What to do next with an operation that stopped halfway. */
export const OperationAction = Schema.Literals(["continue", "abort", "skip"]);
export type OperationAction = typeof OperationAction.Type;

/**
 * Which side of a conflicted file to keep: `ours` or `theirs` whole, or `resolved` for the file as it
 * is now. In a merge `ours` is the branch checked out; in a rebase it is the branch being rebased
 * onto and `theirs` the commit being replayed.
 */
export const ResolveSide = Schema.Literals(["ours", "theirs", "resolved"]);
export type ResolveSide = typeof ResolveSide.Type;

const Root = { root: Schema.NonEmptyString };

/** What a machine serves about a folder's branches and their sync; merged into `MachineRpcs`. */
export const GitBranchRpcs = RpcGroup.make(
  /** Where the folder's repository stands: its branch, upstream, unfinished operation and conflicts. */
  Rpc.make("GitBranchState", { payload: Root, success: GitBranchState, error: CeriumError }),
  /** The repository's local and remote branches. */
  Rpc.make("GitBranches", { payload: Root, success: GitBranchList, error: CeriumError }),
  /**
   * Switches to a branch; one on a remote becomes a local branch that follows it. With uncommitted
   * changes, `changes` says whether they come along (`carry`, the default) or are stashed first.
   */
  Rpc.make("GitSwitch", {
    payload: { ...Root, branch: Schema.NonEmptyString, changes: Schema.optionalKey(SwitchChanges) },
    success: GitOutcome,
    error: CeriumError,
  }),
  /**
   * Makes a branch at the current commit, or at `from` (a branch, tag or commit), and switches to it
   * unless `switch` is false. `changes` is as for `GitSwitch`.
   */
  Rpc.make("GitCreateBranch", {
    payload: {
      ...Root,
      name: Schema.NonEmptyString,
      from: Schema.optionalKey(Schema.NonEmptyString),
      switch: Schema.optionalKey(Schema.Boolean),
      changes: Schema.optionalKey(SwitchChanges),
    },
    success: GitOutcome,
    error: CeriumError,
  }),
  Rpc.make("GitRenameBranch", {
    payload: { ...Root, branch: Schema.NonEmptyString, name: Schema.NonEmptyString },
    error: CeriumError,
  }),
  /** Deletes a local branch. Without `force`, one with unmerged commits is answered, not deleted. */
  Rpc.make("GitDeleteBranch", {
    payload: { ...Root, branch: Schema.NonEmptyString, force: Schema.optionalKey(Schema.Boolean) },
    success: GitDeleteOutcome,
    error: CeriumError,
  }),
  /** Makes a local branch follow a remote one, or follow none without `upstream`. */
  Rpc.make("GitSetUpstream", {
    payload: {
      ...Root,
      branch: Schema.NonEmptyString,
      upstream: Schema.optionalKey(Schema.NonEmptyString),
    },
    error: CeriumError,
  }),
  /**
   * Fetches from every remote and prunes branches deleted there. `quiet` is the panel's background
   * fetch: it never opens a sign-in window, and fails without asking for one.
   */
  Rpc.make("GitFetch", {
    payload: { ...Root, quiet: Schema.optionalKey(Schema.Boolean) },
    success: GitOutcome,
    error: CeriumError,
  }),
  /** Pulls the branch's upstream, merging or rebasing as the user's git configuration says. */
  Rpc.make("GitPull", { payload: Root, success: GitOutcome, error: CeriumError }),
  /**
   * Pushes the branch: `publish` pushes it to `remote` (`origin`, or the only one) and makes it
   * follow, `forceWithLease` overwrites the remote branch unless someone else moved it since the
   * last fetch.
   */
  Rpc.make("GitPush", {
    payload: {
      ...Root,
      mode: Schema.optionalKey(PushMode),
      remote: Schema.optionalKey(Schema.NonEmptyString),
    },
    success: GitOutcome,
    error: CeriumError,
  }),
  /** The stashes, the newest first. */
  Rpc.make("GitStashes", { payload: Root, success: LenientArray(StashEntry), error: CeriumError }),
  /** Puts the uncommitted changes aside, untracked files too with `includeUntracked`. */
  Rpc.make("GitStash", {
    payload: {
      ...Root,
      message: Schema.optionalKey(Schema.String),
      includeUntracked: Schema.optionalKey(Schema.Boolean),
    },
    success: GitOutcome,
    error: CeriumError,
  }),
  /** Applies a stash, and drops it once applied cleanly with `pop`. */
  Rpc.make("GitStashApply", {
    payload: { ...Root, commit: Schema.NonEmptyString, pop: Schema.optionalKey(Schema.Boolean) },
    success: GitOutcome,
    error: CeriumError,
  }),
  Rpc.make("GitStashDrop", {
    payload: { ...Root, commit: Schema.NonEmptyString },
    error: CeriumError,
  }),
  /** Merges a branch into the one checked out; it may stop on conflicts. */
  Rpc.make("GitMerge", {
    payload: { ...Root, branch: Schema.NonEmptyString },
    success: GitOutcome,
    error: CeriumError,
  }),
  /** Continues, skips a step of, or aborts the operation that stopped halfway. */
  Rpc.make("GitOperation", {
    payload: { ...Root, action: OperationAction },
    success: GitOutcome,
    error: CeriumError,
  }),
  /**
   * Settles one conflicted file, `path` from the repository's top: keeps a side whole, or marks the
   * file as it is now resolved.
   */
  Rpc.make("GitResolve", {
    payload: { ...Root, path: Schema.NonEmptyString, side: ResolveSide },
    error: CeriumError,
  }),
);
