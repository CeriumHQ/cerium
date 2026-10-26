import { Schema } from "effect";

import { ReasoningEffort, StoredSpeed } from "./capabilities.ts";
import { withFallback } from "./compat.ts";
import { AgentId, EpochMillis, NonNegativeInt, ProviderId, ThreadId } from "./ids.ts";

/**
 * What an agent may do without asking, ordered from least to most permissive:
 * - `readOnly`: read/search/web tools only (chat mode, read-only children).
 * - `ask`: every write or command goes through Cerium's approval flow.
 * - `acceptEdits`: file edits in the workspace are auto-approved; commands still ask.
 * - `auto`: the harness's own reviewer model approves or refuses each edit and command, and asks the
 *   user only where the harness does.
 * - `fullAccess`: the harness's own bypass mode: nothing asks and no sandbox applies.
 *
 * A mode a newer version added reads as `ask`: asking is never more than it allows.
 */
export const AccessMode = withFallback(
  Schema.Literals(["readOnly", "ask", "acceptEdits", "auto", "fullAccess"]),
  "ask",
);
export type AccessMode = typeof AccessMode.Type;

const accessRank: Record<AccessMode, number> = {
  readOnly: 0,
  ask: 1,
  acceptEdits: 2,
  auto: 3,
  fullAccess: 4,
};

/** Permissions only narrow: a child never gets more access than its lead. */
export const narrowAccess = (lead: AccessMode, requested: AccessMode): AccessMode =>
  accessRank[requested] <= accessRank[lead] ? requested : lead;

/** A state a newer version added reads as `idle`. */
export const AgentState = withFallback(
  Schema.Literals(["queued", "running", "idle", "stopped", "failed"]),
  "idle",
);
export type AgentState = typeof AgentState.Type;

export const ThreadMode = Schema.Literals(["work", "chat"]);
export type ThreadMode = typeof ThreadMode.Type;

/**
 * A work thread's own git worktree: a checkout of its project's repository on a branch of its own,
 * so threads in one project don't change each other's files. Archiving the thread removes the
 * worktree, and restoring it puts the worktree back.
 */
export const ThreadWorktree = Schema.Struct({
  /** The folder the user chose; the thread's `cwd` is the same folder inside the worktree. */
  project: Schema.NonEmptyString,
  /** The worktree's own folder: `cwd`, or above it when the project is a subfolder of its repository. */
  root: Schema.NonEmptyString,
  branch: Schema.NonEmptyString,
  /** The branch the worktree started from (a commit, when that was detached), which its work merges into. */
  base: Schema.NonEmptyString,
});
export type ThreadWorktree = typeof ThreadWorktree.Type;

/** What a thread's worktree holds that its base doesn't: what archiving would put away. */
export const WorktreeChanges = Schema.Struct({
  /** Changed and new files not committed yet, which archiving discards. */
  uncommitted: NonNegativeInt,
  /** Commits on the thread's branch that its base doesn't have; the branch keeps them. */
  unmerged: NonNegativeInt,
});
export type WorktreeChanges = typeof WorktreeChanges.Type;

export const ThreadInfo = Schema.Struct({
  id: ThreadId,
  title: Schema.String,
  mode: ThreadMode,
  /** The folder agents work in; absent for chat threads. */
  cwd: Schema.optionalKey(Schema.NonEmptyString),
  /** The thread's own worktree, when it runs in one; `cwd` is inside it. */
  worktree: Schema.optionalKey(ThreadWorktree),
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
  /** When the user archived it; archived threads leave the sidebar until restored. */
  archivedAt: Schema.optionalKey(EpochMillis),
  /**
   * When a thread the user put off for later comes back to their inbox. Until then the inbox lists it
   * apart, unless it needs them sooner.
   */
  laterUntil: Schema.optionalKey(EpochMillis),
  /**
   * Shared by the threads one message started together, a thread with each model it was sent to
   * (multi agent), so the sidebar can show them as one run.
   */
  runId: Schema.optionalKey(Schema.NonEmptyString),
});
export type ThreadInfo = typeof ThreadInfo.Type;

/** The longest a thread's title may be, in characters. */
export const MAX_THREAD_TITLE = 80;

/** The role every thread's lead agent has. */
export const LEAD_ROLE = "lead";

/** The role of a thread's advisor, a child Cerium starts itself; leads can't spawn one. */
export const ADVISOR_ROLE = "advisor";

/**
 * The role of a cross-harness reviewer, a read-only child Cerium starts when the user asks for a review
 * of a diff; its findings go to the user, not the lead, and leads can't spawn one.
 */
export const REVIEWER_ROLE = "review";

export const AgentInfo = Schema.Struct({
  id: AgentId,
  threadId: ThreadId,
  /** The lead that spawned this agent; absent for the lead itself. */
  parentId: Schema.optionalKey(AgentId),
  role: Schema.NonEmptyString,
  provider: ProviderId,
  model: Schema.NonEmptyString,
  effort: Schema.optionalKey(ReasoningEffort),
  /**
   * Set to Auto: while the effort router is on, it picks the effort of each turn, and `effort` is
   * the level the agent last ran at.
   */
  autoEffort: Schema.optionalKey(Schema.Boolean),
  /** The speed picked for it; absent runs the harness's own default, or a model with no speed setting. */
  speed: Schema.optionalKey(StoredSpeed),
  access: AccessMode,
  state: AgentState,
  providerSessionId: Schema.optionalKey(Schema.NonEmptyString),
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
});
export type AgentInfo = typeof AgentInfo.Type;
