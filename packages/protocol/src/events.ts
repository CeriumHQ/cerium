import { Schema } from "effect";

import { ReasoningEffort } from "./capabilities.ts";
import { AgentId, EpochMillis, EventId, NonNegativeInt, ProviderId, ThreadId } from "./ids.ts";

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

export const EventPayload = Schema.Union([
  SessionStarted,
  MessageDelta,
  MessageCompleted,
  ReasoningDelta,
  ToolCallStarted,
  ToolCallCompleted,
  FileChanged,
  PermissionRequested,
  PermissionResolved,
  UsageReported,
  TurnCompleted,
  AuthRequired,
  AgentError,
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
