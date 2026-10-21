import { LenientArray, withFallback } from "@cerium/protocol";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { FileState } from "./files.ts";

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

/**
 * The calls the Source control panel makes, each since the `RPC_VERSION` beside it. Every git call
 * fails with a `GitError`.
 */
export const GitRpcs = RpcGroup.make(
  /** Since `RPC_VERSION` 17. */
  Rpc.make("GitStatus", { payload: { root: Schema.NonEmptyString }, success: GitStatus, error: GitError }),
);
