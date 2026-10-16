import { Schema } from "effect";

import { ReasoningEffort } from "./capabilities.ts";
import { AgentId, EpochMillis, ProviderId, ThreadId } from "./ids.ts";

/**
 * What an agent may do without asking, ordered from least to most permissive:
 * - `readOnly`: read/search/web tools only (chat mode, read-only children).
 * - `ask`: every write or command goes through Cerium's approval flow.
 * - `acceptEdits`: file edits in the workspace are auto-approved; commands still ask.
 */
export const AccessMode = Schema.Literals(["readOnly", "ask", "acceptEdits"]);
export type AccessMode = typeof AccessMode.Type;

const accessRank: Record<AccessMode, number> = { readOnly: 0, ask: 1, acceptEdits: 2 };

/** Permissions only narrow: a child never gets more access than its lead (architecture §3.1). */
export const narrowAccess = (lead: AccessMode, requested: AccessMode): AccessMode =>
  accessRank[requested] <= accessRank[lead] ? requested : lead;

export const AgentState = Schema.Literals(["queued", "running", "idle", "stopped", "failed"]);
export type AgentState = typeof AgentState.Type;

export const ThreadMode = Schema.Literals(["work", "chat"]);
export type ThreadMode = typeof ThreadMode.Type;

export const ThreadInfo = Schema.Struct({
  id: ThreadId,
  title: Schema.String,
  mode: ThreadMode,
  /** The folder agents work in; absent for chat threads. */
  cwd: Schema.optionalKey(Schema.NonEmptyString),
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
  archivedAt: Schema.optionalKey(EpochMillis),
});
export type ThreadInfo = typeof ThreadInfo.Type;

/** The role every thread's lead agent has. */
export const LEAD_ROLE = "lead";

export const AgentInfo = Schema.Struct({
  id: AgentId,
  threadId: ThreadId,
  /** The lead that spawned this agent; absent for the lead itself. */
  parentId: Schema.optionalKey(AgentId),
  role: Schema.NonEmptyString,
  provider: ProviderId,
  model: Schema.NonEmptyString,
  effort: Schema.optionalKey(ReasoningEffort),
  access: AccessMode,
  state: AgentState,
  providerSessionId: Schema.optionalKey(Schema.NonEmptyString),
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
});
export type AgentInfo = typeof AgentInfo.Type;
