import { Schema } from "effect";

import { ReasoningEffort } from "./capabilities.ts";
import { AgentId, EpochMillis, EventId, NonNegativeInt, ProviderId, ThreadId } from "./ids.ts";
import { AccessMode, AgentState } from "./orchestration.ts";

// Canonical events: every adapter translates its provider's stream into these, and the UI,
// persistence and orchestrator never see provider types (docs/architecture.md §2.3).

export const SessionStarted = Schema.TaggedStruct("SessionStarted", {
  provider: ProviderId,
  /** The harness's own session id, used for resume and fork. */
  providerSessionId: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  effort: Schema.optionalKey(ReasoningEffort),
});

export const MessageDelta = Schema.TaggedStruct("MessageDelta", {
  messageId: Schema.NonEmptyString,
  text: Schema.String,
});

export const MessageCompleted = Schema.TaggedStruct("MessageCompleted", {
  messageId: Schema.NonEmptyString,
  text: Schema.String,
});

export const ReasoningDelta = Schema.TaggedStruct("ReasoningDelta", {
  messageId: Schema.NonEmptyString,
  text: Schema.String,
});

export const ReasoningCompleted = Schema.TaggedStruct("ReasoningCompleted", {
  messageId: Schema.NonEmptyString,
  text: Schema.String,
});

export const ToolCallStarted = Schema.TaggedStruct("ToolCallStarted", {
  callId: Schema.NonEmptyString,
  toolName: Schema.NonEmptyString,
  input: Schema.Unknown,
});

export const ToolCallCompleted = Schema.TaggedStruct("ToolCallCompleted", {
  callId: Schema.NonEmptyString,
  output: Schema.Unknown,
  isError: Schema.Boolean,
});

export const FileChanged = Schema.TaggedStruct("FileChanged", {
  path: Schema.NonEmptyString,
  change: Schema.Literals(["created", "modified", "deleted"]),
});

export const PermissionRequested = Schema.TaggedStruct("PermissionRequested", {
  requestId: Schema.NonEmptyString,
  toolName: Schema.NonEmptyString,
  /** One-line, human-readable description of what the agent wants to do. */
  summary: Schema.String,
  input: Schema.Unknown,
});

export const PermissionResolved = Schema.TaggedStruct("PermissionResolved", {
  requestId: Schema.NonEmptyString,
  decision: Schema.Literals(["allow", "deny"]),
  scope: Schema.Literals(["once", "session"]),
});

/** Usage for one completed turn. `inputTokens` excludes cache reads, which are `cachedInputTokens`. */
export const UsageReported = Schema.TaggedStruct("UsageReported", {
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cachedInputTokens: Schema.optionalKey(NonNegativeInt),
  costUsd: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
});

export const TurnCompleted = Schema.TaggedStruct("TurnCompleted", {
  stopReason: Schema.Literals(["completed", "interrupted", "maxTurns", "error"]),
});

export const AuthRequired = Schema.TaggedStruct("AuthRequired", {
  provider: ProviderId,
  reason: Schema.String,
  /** The harness's own login command, run in Cerium's terminal. Cerium never sees credentials. */
  loginCommand: Schema.optionalKey(Schema.NonEmptyString),
});

export const AgentError = Schema.TaggedStruct("AgentError", {
  kind: Schema.Literals(["transient", "rateLimit", "versionMismatch", "crash", "unknown"]),
  message: Schema.String,
  retryable: Schema.Boolean,
});

// Orchestrator events: emitted by Cerium itself into an agent's log, never by adapters.

/** Something Cerium delivered to an agent as the start of a turn. */
export const InputItem = Schema.Union([
  Schema.TaggedStruct("FromUser", { text: Schema.String }),
  Schema.TaggedStruct("ChildFinishedTurn", {
    agentId: AgentId,
    role: Schema.NonEmptyString,
    /** The child's final message of the turn, truncated to the delivery size cap. */
    text: Schema.String,
  }),
  Schema.TaggedStruct("FromAgent", {
    agentId: AgentId,
    threadId: ThreadId,
    text: Schema.String,
  }),
  Schema.TaggedStruct("SystemNotice", { text: Schema.String }),
]);
export type InputItem = typeof InputItem.Type;

/** The batch of inputs sent to the harness as one turn. */
export const TurnInput = Schema.TaggedStruct("TurnInput", {
  items: Schema.NonEmptyArray(InputItem),
});

export const AgentSpawned = Schema.TaggedStruct("AgentSpawned", {
  childId: AgentId,
  role: Schema.NonEmptyString,
  provider: ProviderId,
  model: Schema.NonEmptyString,
  access: AccessMode,
});

export const AgentStateChanged = Schema.TaggedStruct("AgentStateChanged", {
  state: AgentState,
});

/** A spawn outside the catalog waits for the user (docs/architecture.md §3.3). */
export const SpawnApprovalRequested = Schema.TaggedStruct("SpawnApprovalRequested", {
  requestId: Schema.NonEmptyString,
  role: Schema.NonEmptyString,
  provider: ProviderId,
  model: Schema.NonEmptyString,
});

export const SpawnApprovalResolved = Schema.TaggedStruct("SpawnApprovalResolved", {
  requestId: Schema.NonEmptyString,
  decision: Schema.Literals(["allow", "deny"]),
});

export const EventPayload = Schema.Union([
  SessionStarted,
  MessageDelta,
  MessageCompleted,
  ReasoningDelta,
  ReasoningCompleted,
  ToolCallStarted,
  ToolCallCompleted,
  FileChanged,
  PermissionRequested,
  PermissionResolved,
  UsageReported,
  TurnCompleted,
  AuthRequired,
  AgentError,
  TurnInput,
  AgentSpawned,
  AgentStateChanged,
  SpawnApprovalRequested,
  SpawnApprovalResolved,
]);
export type EventPayload = typeof EventPayload.Type;

export const AgentEvent = Schema.Struct({
  id: EventId,
  threadId: ThreadId,
  agentId: AgentId,
  /** Strictly increasing per agent; the order events are persisted and replayed in. */
  sequence: NonNegativeInt,
  at: EpochMillis,
  payload: EventPayload,
  /** The untouched provider payload this event was translated from. */
  raw: Schema.optionalKey(Schema.Unknown),
});
export type AgentEvent = typeof AgentEvent.Type;
