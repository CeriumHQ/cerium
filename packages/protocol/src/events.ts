import { Schema } from "effect";

import { ReasoningEffort } from "./capabilities.ts";
import { withFallback } from "./compat.ts";
import { AgentId, EpochMillis, EventId, NonNegativeInt, ProviderId, ThreadId } from "./ids.ts";
import { AccessMode, AgentState } from "./orchestration.ts";

// Canonical events: every adapter translates its provider's stream into these, and the UI,
// persistence and orchestrator never see provider types (docs/architecture.md §2.3). Values a newer
// version may add read as a fallback (§14.1).

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
  change: withFallback(Schema.Literals(["created", "modified", "deleted"]), "modified"),
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
  stopReason: withFallback(Schema.Literals(["completed", "interrupted", "maxTurns", "error"]), "completed"),
});

export const AuthRequired = Schema.TaggedStruct("AuthRequired", {
  provider: ProviderId,
  reason: Schema.String,
  /** The harness's own login command, run in Cerium's terminal. Cerium never sees credentials. */
  loginCommand: Schema.optionalKey(Schema.NonEmptyString),
});

export const AgentError = Schema.TaggedStruct("AgentError", {
  kind: withFallback(
    Schema.Literals(["transient", "rateLimit", "versionMismatch", "crash", "unknown"]),
    "unknown",
  ),
  message: Schema.String,
  retryable: Schema.Boolean,
});

// Orchestrator events: emitted by Cerium itself into an agent's log, never by adapters.

/** A file sent with a message: the user's own file, or Cerium's copy of something pasted. */
export const Attachment = Schema.Struct({
  /** Absolute path on disk. */
  path: Schema.NonEmptyString,
  /** The name the user saw, such as `image.png` for a pasted screenshot. */
  name: Schema.NonEmptyString,
  mediaType: Schema.String,
});
export type Attachment = typeof Attachment.Type;

/**
 * Something the user tagged in the message box. The message's text carries each as a token (see
 * `mentionToken`), which agents read and the transcript shows as a chip.
 */
export const Mention = Schema.Union([
  Schema.TaggedStruct("FileMention", {
    /** Relative to the thread's folder, with forward slashes and no trailing one. */
    path: Schema.NonEmptyString,
    folder: Schema.Boolean,
  }),
  Schema.TaggedStruct("SkillMention", {
    name: Schema.NonEmptyString,
    /** The skill's definition file, when its harness reports one. */
    path: Schema.optionalKey(Schema.NonEmptyString),
  }),
]);
export type Mention = typeof Mention.Type;

/** How a mention reads in the message: `@path` for a file, `@path/` for a folder, `$name` for a skill. */
export const mentionToken = (mention: Mention): string =>
  mention._tag === "FileMention" ? `@${mention.path}${mention.folder ? "/" : ""}` : `$${mention.name}`;

/** A message the user sent an agent. */
export const FromUser = Schema.TaggedStruct("FromUser", {
  /** Given when Cerium accepts the message, so its `TurnInput` can be matched to its `MessageQueued`. */
  id: Schema.optionalKey(Schema.NonEmptyString),
  text: Schema.String,
  attachments: Schema.optionalKey(Schema.Array(Attachment)),
  mentions: Schema.optionalKey(Schema.Array(Mention)),
});
export type FromUser = typeof FromUser.Type;

/** Something Cerium delivered to an agent as the start of a turn. */
export const InputItem = Schema.Union([
  FromUser,
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

/**
 * The user's message, recorded the moment Cerium accepts it. It waits for the agent's session to
 * start and for any running turn to end; the `TurnInput` that delivers it carries the same id.
 */
export const MessageQueued = Schema.TaggedStruct("MessageQueued", {
  message: FromUser,
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
  MessageQueued,
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
