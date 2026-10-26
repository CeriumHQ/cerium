import {
  AgentId,
  EpochMillis,
  LenientArray,
  ProviderId,
  ReasoningEffort,
  ThreadId,
  withFallback,
} from "@cerium/protocol";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { CeriumError } from "./error.ts";

// Reviews of a diff by an agent on another harness than the one that wrote it: what the next commit
// takes, a branch before its pull request, or one of an agent's turns. Each finding lands as a
// comment on the diff's lines, which the user sends back to the thread's agent or dismisses.

/** What a review reads. */
export const ReviewTarget = Schema.Union([
  /** What the next commit takes in the repository at `root`: what's staged, or everything when nothing is. */
  Schema.TaggedStruct("Changes", { root: Schema.NonEmptyString }),
  /** The commits of the branch checked out at `cwd` that `base` doesn't have, before a pull request. */
  Schema.TaggedStruct("Branch", { cwd: Schema.NonEmptyString, base: Schema.NonEmptyString }),
  /** The files one of an agent's turns changed, between the folder's snapshots from before and after it. */
  Schema.TaggedStruct("Turn", {
    root: Schema.NonEmptyString,
    turnId: Schema.NonEmptyString,
    before: Schema.NonEmptyString,
    after: Schema.NonEmptyString,
    paths: Schema.Array(Schema.NonEmptyString),
  }),
]);
export type ReviewTarget = typeof ReviewTarget.Type;

/** The model a review runs on. */
export const ReviewerModel = Schema.Struct({
  provider: ProviderId,
  model: Schema.NonEmptyString,
  effort: Schema.optionalKey(ReasoningEffort),
});
export type ReviewerModel = typeof ReviewerModel.Type;

/** A line a finding covers, as the diff shows it. */
export const ReviewLine = Schema.Struct({
  marker: Schema.Literals(["+", "-", " "]),
  text: Schema.String,
  /** The new side's number for an added or unchanged line, the old side's for a removed one. */
  number: Schema.Int,
});
export type ReviewLine = typeof ReviewLine.Type;

/** What the user made of a finding: not yet anything, sent to the thread's agent, or dismissed. */
export const FindingState = withFallback(Schema.Literals(["open", "sent", "dismissed"]), "open");
export type FindingState = typeof FindingState.Type;

export const ReviewFinding = Schema.Struct({
  id: Schema.NonEmptyString,
  /** Relative to the repository's top (a turn's folder), with forward slashes. */
  path: Schema.String,
  /** The lines it covers, by the numbers of `side`: the new file's, or the old one's for removed lines. */
  start: Schema.Int,
  end: Schema.Int,
  side: withFallback(Schema.Literals(["new", "old"]), "new"),
  severity: withFallback(Schema.Literals(["high", "medium", "low"]), "medium"),
  /** What's wrong, in a line. */
  title: Schema.String,
  /** Why, and what to do about it. */
  body: Schema.String,
  /** The diff's lines it covers; empty when they fall outside the diff. */
  lines: Schema.Array(ReviewLine),
  state: FindingState,
});
export type ReviewFinding = typeof ReviewFinding.Type;

/**
 * Where a review stands: its reviewer reads (`running`), it answered (`done`), it failed or was
 * stopped (`message` says why).
 */
export const ReviewRunState = withFallback(
  Schema.Literals(["running", "done", "failed", "stopped"]),
  "failed",
);
export type ReviewRunState = typeof ReviewRunState.Type;

export const ReviewRecord = Schema.Struct({
  id: Schema.NonEmptyString,
  threadId: ThreadId,
  target: ReviewTarget,
  /** What it reads, in a few words: "3 staged files", "feature/x against main". */
  label: Schema.String,
  /** The files the diff holds. */
  files: Schema.Array(Schema.String),
  reviewer: ReviewerModel,
  /** The reviewer agent, while it runs and after. */
  agentId: Schema.optionalKey(AgentId),
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
  state: ReviewRunState,
  message: Schema.optionalKey(Schema.String),
  /** The reviewer's word on the change as a whole. */
  summary: Schema.optionalKey(Schema.String),
  findings: LenientArray(ReviewFinding),
});
export type ReviewRecord = typeof ReviewRecord.Type;

export const ReviewRpcs = RpcGroup.make(
  /** A thread's reviews, oldest first, now and after every change. Since `RPC_VERSION` 38. */
  Rpc.make("WatchReviews", {
    payload: { threadId: ThreadId },
    success: LenientArray(ReviewRecord),
    stream: true,
  }),
  /**
   * Starts a review of `target` for the thread's agents, on `reviewer`, or else a model of the user's
   * roster on another harness than the thread's lead. Resolves once it runs. Since `RPC_VERSION` 38.
   */
  Rpc.make("StartReview", {
    payload: { threadId: ThreadId, target: ReviewTarget, reviewer: Schema.optionalKey(ReviewerModel) },
    success: ReviewRecord,
    error: CeriumError,
  }),
  /** Marks a finding sent, dismissed, or open again. Since `RPC_VERSION` 38. */
  Rpc.make("ResolveReviewFinding", {
    payload: { reviewId: Schema.NonEmptyString, findingId: Schema.NonEmptyString, state: FindingState },
    error: CeriumError,
  }),
  /** Stops a review that's running. Since `RPC_VERSION` 38. */
  Rpc.make("StopReview", {
    payload: { reviewId: Schema.NonEmptyString },
    error: CeriumError,
  }),
);
