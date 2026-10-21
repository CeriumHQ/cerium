import { LenientArray, withFallback } from "@cerium/protocol";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { DiffLine, FileDiff, FileState } from "./files.ts";

// What the Source control panel asks of a machine about the git repository a work thread's folder is
// in. Each request names `root`, any folder inside the repository; the paths it names and is answered
// with are relative to the repository's top (`GitStatus.top`), with forward slashes, whatever folder
// of it the thread works in: git stages and commits for the whole repository.

/**
 * A git command that didn't do what was asked. `message` is written for the user; `output` is what
 * git, or a hook it ran, printed, for when the message isn't enough.
 */
export class GitError extends Schema.TaggedError<GitError>()("GitError", {
  message: Schema.String,
  output: Schema.optionalKey(Schema.String),
}) {}

/** A file that differs on one side of git's index: staged against the last commit, or unstaged against what's staged. */
export const GitFileChange = Schema.Struct({
  path: Schema.NonEmptyString,
  state: withFallback(FileState, "modified"),
  /** Where a renamed file was before. */
  from: Schema.optionalKey(Schema.NonEmptyString),
});
export type GitFileChange = typeof GitFileChange.Type;

/** A repository's files as git's index sees them. */
export const GitStatus = Schema.Struct({
  /** The folder is in a git repository; nothing else is said without one. */
  repository: Schema.Boolean,
  /** The repository's top folder, as the machine names it, which every path is relative to. */
  top: Schema.optionalKey(Schema.NonEmptyString),
  /** What the next commit takes: staged, against the last commit. */
  staged: LenientArray(GitFileChange),
  /** What isn't staged, new files included, against what is. */
  unstaged: LenientArray(GitFileChange),
  /** What a merge left for the user to settle (`GitState` says how), which is neither until they do. */
  conflicted: LenientArray(GitFileChange),
  /** There were more changes than are listed. */
  truncated: Schema.optionalKey(Schema.Boolean),
});
export type GitStatus = typeof GitStatus.Type;

/** The two comparisons a changed file has: what's staged against the last commit, and what isn't against that. */
export const GitSide = Schema.Literals(["staged", "unstaged"]);
export type GitSide = typeof GitSide.Type;

/** A line of a diff as `GitDiff` sent it, and whether the user picked it. */
export const PickedLine = Schema.Struct({
  ...DiffLine.fields,
  picked: Schema.Boolean,
});
export type PickedLine = typeof PickedLine.Type;

/** A hunk of a diff as `GitDiff` sent it, every line of it, with the ones the user picked. */
export const PickedHunk = Schema.Struct({
  oldStart: Schema.Finite,
  newStart: Schema.Finite,
  lines: Schema.Array(PickedLine),
});
export type PickedHunk = typeof PickedHunk.Type;

/** A commit just made: its short hash and its message's first line. */
export const MadeCommit = Schema.Struct({
  commit: Schema.NonEmptyString,
  subject: Schema.String,
});
export type MadeCommit = typeof MadeCommit.Type;

/** What a request acts on: files, folders, or `""` for the whole repository. */
const Paths = Schema.Array(Schema.String).check(Schema.isMinLength(1));

/** Unchanged lines around each change, as `DiffFile` takes them. */
const Context = Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)));

/**
 * The calls the Source control panel makes, each since the `RPC_VERSION` beside it. Every git call
 * fails with a `GitError`.
 */
export const GitRpcs = RpcGroup.make(
  /** Since `RPC_VERSION` 17. */
  Rpc.make("GitStatus", { payload: { root: Schema.NonEmptyString }, success: GitStatus, error: GitError }),
  /**
   * One side of a changed file: what's staged against the last commit, or what isn't against what's
   * staged, a new file's whole text included. `from` is where a renamed file was. Since `RPC_VERSION` 18.
   */
  Rpc.make("GitDiff", {
    payload: {
      root: Schema.NonEmptyString,
      path: Schema.NonEmptyString,
      side: GitSide,
      from: Schema.optionalKey(Schema.NonEmptyString),
      context: Context,
    },
    success: FileDiff,
    error: GitError,
  }),
  /**
   * Stages everything under `paths`: changes, new files and deletions. A conflicted file staged is
   * settled. Since `RPC_VERSION` 18.
   */
  Rpc.make("StageFiles", { payload: { root: Schema.NonEmptyString, paths: Paths }, error: GitError }),
  /** Takes what's staged under `paths` out of the next commit, leaving the files as they are. Since `RPC_VERSION` 18. */
  Rpc.make("UnstageFiles", { payload: { root: Schema.NonEmptyString, paths: Paths }, error: GitError }),
  /**
   * Throws away what isn't staged under `paths`, for good: changed files go back to what's staged,
   * new ones are deleted. Files git ignores stay. Since `RPC_VERSION` 18.
   */
  Rpc.make("DiscardFiles", { payload: { root: Schema.NonEmptyString, paths: Paths }, error: GitError }),
  /**
   * Stages, unstages or discards the picked lines of a changed file, from its diff on `side` as
   * `GitDiff` sent it with `context`: `stage` and `discard` take the unstaged side, `unstage` the
   * staged one. Refused when the diff isn't what was sent any more. Since `RPC_VERSION` 18.
   */
  Rpc.make("ApplyLines", {
    payload: {
      root: Schema.NonEmptyString,
      path: Schema.NonEmptyString,
      action: Schema.Literals(["stage", "unstage", "discard"]),
      context: Context,
      hunks: Schema.Array(PickedHunk),
    },
    error: GitError,
  }),
  /**
   * Commits what's staged with `message`, or, with `all`, everything changed, staging it first.
   * `amend` replaces the last commit, keeping its message when `message` is empty. Since `RPC_VERSION` 18.
   */
  Rpc.make("Commit", {
    payload: {
      root: Schema.NonEmptyString,
      message: Schema.String,
      amend: Schema.optionalKey(Schema.Boolean),
      all: Schema.optionalKey(Schema.Boolean),
    },
    success: MadeCommit,
    error: GitError,
  }),
  /** The last commit's whole message, for amending it; empty before the first commit. Since `RPC_VERSION` 18. */
  Rpc.make("LastCommitMessage", {
    payload: { root: Schema.NonEmptyString },
    success: Schema.Struct({ message: Schema.String }),
    error: GitError,
  }),
);
