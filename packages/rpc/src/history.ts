import { EpochMillis, LenientArray } from "@cerium/protocol";
import { Schema } from "effect";

import { FileChange } from "./files.ts";

// What Source control's History tab asks of a machine about a work thread's branch: its commits a
// page at a time, one commit with the files it changed, and one of those files against its parent.
// Paths are relative to the folder asked about, as in the file explorer.

/** A ref a commit carries: a local branch, a tag, or a remote-tracking branch (an upstream). */
export const CommitRef = Schema.Struct({
  kind: Schema.Literals(["branch", "tag", "upstream"]),
  /** Its short name, as the UI shows it: `main`, `v1.2.0`, `origin/main`. */
  name: Schema.NonEmptyString,
  /** The branch checked out in the folder. */
  current: Schema.optionalKey(Schema.Boolean),
});
export type CommitRef = typeof CommitRef.Type;

/** A commit of the branch checked out in the folder. */
export const Commit = Schema.Struct({
  sha: Schema.NonEmptyString,
  /** Git's short form of `sha`, as many characters as keep it unique. */
  short: Schema.NonEmptyString,
  /** The first line of the message. */
  subject: Schema.String,
  /** The author's name. */
  author: Schema.String,
  /** When the author wrote it. */
  at: EpochMillis,
  refs: Schema.Array(CommitRef),
  /** On no remote branch yet. Only marked in a repository that has a remote to push to. */
  unpushed: Schema.optionalKey(Schema.Boolean),
});
export type Commit = typeof Commit.Type;

/** A page of the branch's commits, newest first. */
export const CommitPage = Schema.Struct({
  /** The folder is in a git repository. Without one, there is no history to show. */
  repository: Schema.Boolean,
  commits: LenientArray(Commit),
  /** Older commits follow this page. */
  more: Schema.Boolean,
});
export type CommitPage = typeof CommitPage.Type;

/** One commit, in full: its whole message and the files of the folder it changed. */
export const CommitDetail = Schema.Struct({
  commit: Commit,
  /** The whole message as git stores it, subject and body. */
  message: Schema.String,
  /** The files under the folder the commit changed, against its first parent. */
  files: LenientArray(FileChange),
  /** There were more changed files than are listed. */
  truncated: Schema.optionalKey(Schema.Boolean),
});
export type CommitDetail = typeof CommitDetail.Type;

/** What the clone prints as it runs: git's progress lines, then the folder it made. */
export const CloneEvent = Schema.Union([
  Schema.TaggedStruct("Progress", { text: Schema.String }),
  Schema.TaggedStruct("Cloned", { path: Schema.NonEmptyString }),
]);
export type CloneEvent = typeof CloneEvent.Type;
