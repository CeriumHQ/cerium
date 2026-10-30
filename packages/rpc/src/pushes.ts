import { AgentId, EpochMillis, LenientArray, ThreadId } from "@cerium/protocol";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

import { CeriumError } from "./error.ts";

// Pushes agents make with Cerium's `push` tool: the repository's own pre-push checks as they run,
// the commits that went out, and the CI checks GitHub runs on them, followed until they finish.
// Each lives in its thread, which shows it where the agent called the tool.

/**
 * Where a push stands: its pre-push hook runs (`checking`), git sends it (`pushing`), it landed, the
 * remote refused it (`rejected`, usually because the branch moved), or it failed (the hook, or git).
 */
export const PushStage = Schema.Literals(["checking", "pushing", "pushed", "rejected", "failed"]);
export type PushStage = typeof PushStage.Type;

/**
 * One step of the pre-push hook, from the `> label` lines it prints. `done` is a step that ended
 * without saying how.
 */
export const HookStep = Schema.Struct({
  label: Schema.String,
  state: Schema.Literals(["running", "passed", "failed", "done"]),
  startedAt: EpochMillis,
  endedAt: Schema.optionalKey(EpochMillis),
});
export type HookStep = typeof HookStep.Type;

export const PushedCommit = Schema.Struct({ sha: Schema.String, subject: Schema.String });
export type PushedCommit = typeof PushedCommit.Type;

/** A CI check as GitHub reports one: a job of a workflow run. */
export const PushCheckState = Schema.Literals([
  "queued",
  "waiting",
  "running",
  "passed",
  "failed",
  "cancelled",
  "skipped",
]);
export type PushCheckState = typeof PushCheckState.Type;

export const PushCheck = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  state: PushCheckState,
  /** The workflow run it belongs to. */
  runId: Schema.String,
  startedAt: Schema.optionalKey(EpochMillis),
  completedAt: Schema.optionalKey(EpochMillis),
  url: Schema.optionalKey(Schema.String),
  /** The step it failed at. */
  failedStep: Schema.optionalKey(Schema.String),
});
export type PushCheck = typeof PushCheck.Type;

export const PushRun = Schema.Struct({
  id: Schema.String,
  /** The workflow's name. */
  name: Schema.String,
  number: Schema.optionalKey(Schema.Int),
  attempt: Schema.Int,
  url: Schema.String,
  state: PushCheckState,
});
export type PushRun = typeof PushRun.Type;

/** A failed check's last log lines, and what they say in a line. */
export const CheckFailure = Schema.Struct({
  checkId: Schema.String,
  name: Schema.String,
  step: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  log: Schema.String,
  url: Schema.optionalKey(Schema.String),
});
export type CheckFailure = typeof CheckFailure.Type;

/**
 * The CI of the pushed commit: `waiting` for GitHub to start its runs, `running`, then how they
 * ended. `none` when the commit started no runs, `unavailable` when Cerium can't follow them (no
 * GitHub remote, `gh` missing or signed out), `superseded` when a newer push cancelled them.
 */
export const CiState = Schema.Literals([
  "waiting",
  "running",
  "passed",
  "failed",
  "cancelled",
  "superseded",
  "none",
  "unavailable",
]);
export type CiState = typeof CiState.Type;

export const PushCi = Schema.Struct({
  state: CiState,
  /** Why it's `none` or `unavailable`, in a line for the user. */
  note: Schema.optionalKey(Schema.String),
  runs: Schema.Array(PushRun),
  checks: Schema.Array(PushCheck),
  failures: Schema.Array(CheckFailure),
  finishedAt: Schema.optionalKey(EpochMillis),
});
export type PushCi = typeof PushCi.Type;

export const PushRecord = Schema.Struct({
  id: Schema.NonEmptyString,
  threadId: ThreadId,
  agentId: AgentId,
  cwd: Schema.String,
  remote: Schema.String,
  branch: Schema.String,
  followCi: Schema.optionalKey(Schema.Boolean),
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
  stage: PushStage,
  hook: Schema.Array(HookStep),
  /** What the hook and git printed, its last lines. */
  output: Schema.String,
  commits: Schema.Array(PushedCommit),
  /** The commit pushed, in full. */
  head: Schema.optionalKey(Schema.String),
  /** Why it was rejected or failed, in plain words. */
  message: Schema.optionalKey(Schema.String),
  /** The GitHub repository it went to, as `owner/name`. */
  repository: Schema.optionalKey(Schema.String),
  ci: Schema.optionalKey(PushCi),
});
export type PushRecord = typeof PushRecord.Type;

/** What the user can do with a push's checks from its thread. */
export const PushAction = Schema.Literals(["rerunFailed", "cancel", "sendToAgent"]);
export type PushAction = typeof PushAction.Type;

export const PushRpcs = RpcGroup.make(
  /** A thread's pushes, oldest first, now and after every change. Since `RPC_VERSION` 34. */
  Rpc.make("WatchPushes", {
    payload: { threadId: ThreadId },
    success: LenientArray(PushRecord),
    stream: true,
  }),
  /**
   * Re-runs a push's failed checks, cancels its runs, or hands its failures to the agent that pushed.
   * Since `RPC_VERSION` 34.
   */
  Rpc.make("PushAction", {
    payload: { pushId: Schema.NonEmptyString, action: PushAction },
    error: CeriumError,
  }),
);
