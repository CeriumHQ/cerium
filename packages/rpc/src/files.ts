import { LenientArray, withFallback } from "@cerium/protocol";
import { Schema } from "effect";

// What the file explorer asks of a machine about a work thread's folder. Every path is relative to
// the folder asked about, with forward slashes and no trailing one; the folder itself is "".

/** How git sees a file that differs from the last commit. */
export const FileState = Schema.Literals([
  "modified",
  "added",
  "deleted",
  "renamed",
  "untracked",
  "conflicted",
]);
export type FileState = typeof FileState.Type;

/** One file or folder inside a folder. */
export const FileEntry = Schema.Struct({
  /** Its name alone, not its path. */
  name: Schema.NonEmptyString,
  folder: Schema.Boolean,
  /** Git ignores it: it isn't in the repository, and won't be committed. */
  ignored: Schema.optionalKey(Schema.Boolean),
  /** A folder of dependencies, build output or caches, which nobody browses unless they choose to. */
  heavy: Schema.optionalKey(Schema.Boolean),
  /** A symbolic link, or a junction. */
  link: Schema.optionalKey(Schema.Boolean),
});
export type FileEntry = typeof FileEntry.Type;

/** A folder's entries, folders first, each group by name. */
export const FileListing = Schema.Struct({
  entries: Schema.Array(FileEntry),
  /** The listing stops short: a folder with more entries than the explorer lists at once. */
  truncated: Schema.optionalKey(Schema.Boolean),
});
export type FileListing = typeof FileListing.Type;

/** A file git reports as changed. */
export const FileChange = Schema.Struct({
  /** A folder that is new as a whole ends with `/`: everything in it is untracked. */
  path: Schema.NonEmptyString,
  state: withFallback(FileState, "modified"),
  /** Where a renamed file was before. */
  from: Schema.optionalKey(Schema.NonEmptyString),
});
export type FileChange = typeof FileChange.Type;

/** What git says about a folder's files: every one that differs from the last commit. */
export const FileStatuses = Schema.Struct({
  /** The folder is in a git repository. Without one, there are no states to show. */
  repository: Schema.Boolean,
  changes: LenientArray(FileChange),
  /** There were more changes than are listed. */
  truncated: Schema.optionalKey(Schema.Boolean),
});
export type FileStatuses = typeof FileStatuses.Type;

/** What changed in a folder since the last batch, so the explorer reads only that again. */
export const FilesChanged = Schema.Struct({
  /** Paths whose entries or contents changed, at most a few hundred. */
  paths: Schema.Array(Schema.String),
  /** Git's view of the working tree may differ now. */
  status: Schema.Boolean,
  /** There were more changes than are listed: read everything again. */
  overflow: Schema.optionalKey(Schema.Boolean),
});
export type FilesChanged = typeof FilesChanged.Type;
