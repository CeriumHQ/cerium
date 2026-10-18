import { Schema } from "effect";

// What the message box offers to tag: files and folders in a thread's folder (`@`) and the skills
// the lead's harness has (`$`).

/** A file or folder in a thread's folder. */
export const WorkspaceEntry = Schema.Struct({
  /** Relative to the folder searched, with forward slashes and no trailing one. */
  path: Schema.NonEmptyString,
  folder: Schema.Boolean,
});
export type WorkspaceEntry = typeof WorkspaceEntry.Type;

/** A skill a harness can run, as it reports it. */
export const SkillInfo = Schema.Struct({
  /** What the user types after `$`, and what the harness invokes. */
  name: Schema.NonEmptyString,
  description: Schema.optionalKey(Schema.String),
  /** The skill's definition file, when the harness reports one. */
  path: Schema.optionalKey(Schema.NonEmptyString),
});
export type SkillInfo = typeof SkillInfo.Type;

/** An image's bytes, base64-encoded, for the UI to show. */
export const ImageData = Schema.Struct({
  mediaType: Schema.String,
  data: Schema.String,
});
export type ImageData = typeof ImageData.Type;

/** A folder the composer offers to work in. */
export const ProjectInfo = Schema.Struct({
  /** Absolute, as the user picked it or a thread ran in it. */
  path: Schema.NonEmptyString,
  /** When a thread last started in it, or the user last chose it. */
  usedAt: Schema.Finite,
  /** The folder is gone (moved, deleted, or on a drive that isn't there right now). */
  missing: Schema.optionalKey(Schema.Boolean),
});
export type ProjectInfo = typeof ProjectInfo.Type;
