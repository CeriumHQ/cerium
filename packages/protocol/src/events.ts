import { Schema } from "effect";

import { ReasoningEffort } from "./capabilities.ts";
import { withFallback } from "./compat.ts";
import { AgentId, EpochMillis, EventId, NonNegativeInt, ProviderId, ThreadId } from "./ids.ts";
import { AccessMode, AgentState } from "./orchestration.ts";

// Canonical events: every adapter translates its provider's stream into these, and the UI,
// persistence and orchestrator never see provider types. Values a newer version may add read as a
// fallback.

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

/**
 * One item of an agent's todo list or plan. Statuses a newer version adds read as `pending`.
 * `cancelled` is for harnesses that drop an item without finishing it.
 */
export const TodoItem = Schema.Struct({
  /** The harness's own id for the item, when it has one (Claude's task ids). */
  id: Schema.optionalKey(Schema.NonEmptyString),
  text: Schema.String,
  status: withFallback(Schema.Literals(["pending", "inProgress", "completed", "cancelled"]), "pending"),
  /** What the agent is doing while the item is in progress ("Running the tests"), when the harness says. */
  activeText: Schema.optionalKey(Schema.NonEmptyString),
});
export type TodoItem = typeof TodoItem.Type;

/**
 * The agent's todo list changed. It carries the whole current list, so the latest event is the list:
 * adapters turn the partial or merged updates some harnesses report into the full list. An empty list
 * clears it.
 */
export const TodosUpdated = Schema.TaggedStruct("TodosUpdated", {
  items: Schema.Array(TodoItem),
  /** Why the agent changed its plan, when the harness gives a reason. */
  explanation: Schema.optionalKey(Schema.String),
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

/** One choice offered with a question. */
export const QuestionOption = Schema.Struct({
  label: Schema.NonEmptyString,
  description: Schema.optionalKey(Schema.String),
});
export type QuestionOption = typeof QuestionOption.Type;

/** One question an agent asks the user. */
export const Question = Schema.Struct({
  /** A few words naming what is asked; absent when the agent gives none. */
  header: Schema.optionalKey(Schema.String),
  question: Schema.NonEmptyString,
  /** Empty for a question that takes the user's own words alone. */
  options: Schema.Array(QuestionOption),
  /** More than one option may be picked. */
  multiSelect: Schema.Boolean,
  /** The user may answer in their own words ("Other"), instead of or beside the options. */
  allowOther: Schema.Boolean,
});
export type Question = typeof Question.Type;

/** What the user answered to one question. */
export const QuestionAnswer = Schema.Struct({
  /** The labels of the options picked. */
  choices: Schema.Array(Schema.String),
  /** The user's own words, when they typed any. */
  text: Schema.optionalKey(Schema.String),
});
export type QuestionAnswer = typeof QuestionAnswer.Type;

/** An answer as one line: the picks, then the user's own words. */
export const answerText = (answer: QuestionAnswer): string =>
  [
    ...answer.choices,
    ...(answer.text !== undefined && answer.text.trim() !== "" ? [answer.text.trim()] : []),
  ].join(", ");

/** What the user did with a question an agent asked: answered it, one answer per question in order, or declined to. */
export const QuestionResponse = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("answered"), answers: Schema.Array(QuestionAnswer) }),
  Schema.Struct({ outcome: Schema.Literal("dismissed") }),
]);
export type QuestionResponse = typeof QuestionResponse.Type;

/**
 * An agent asks the user one or more questions with Cerium's `ask_user`, the only question tool agents
 * have. Like a permission request, it stays open until a `QuestionResolved` with the same `requestId`
 * closes it; the agent hears the answer as a notice.
 */
export const QuestionAsked = Schema.TaggedStruct("QuestionAsked", {
  requestId: Schema.NonEmptyString,
  questions: Schema.NonEmptyArray(Question),
});

export const QuestionResolved = Schema.TaggedStruct("QuestionResolved", {
  requestId: Schema.NonEmptyString,
  /**
   * `answered`: the user answered, and `answers` holds one per question, in order. `dismissed`: the
   * user declined to. `expired`: nobody did before the question could no longer be answered (the agent
   * was interrupted or stopped, or its session ended).
   */
  outcome: withFallback(Schema.Literals(["answered", "dismissed", "expired"]), "expired"),
  answers: Schema.optionalKey(Schema.Array(QuestionAnswer)),
});

/** Usage for one completed turn. `inputTokens` excludes cache reads, which are `cachedInputTokens`. */
export const UsageReported = Schema.TaggedStruct("UsageReported", {
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cachedInputTokens: Schema.optionalKey(NonNegativeInt),
  costUsd: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
});

export const TurnCompleted = Schema.TaggedStruct("TurnCompleted", {
  /**
   * `steered`: Cerium interrupted the turn to hand the agent the user's messages that waited behind
   * it, which start the next turn.
   */
  stopReason: withFallback(
    Schema.Literals(["completed", "interrupted", "steered", "maxTurns", "error"]),
    "completed",
  ),
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
  /**
   * The lead that wrote this message for the user, which started this thread for them with
   * `create_thread`; the title is its thread's when it did.
   */
  writtenBy: Schema.optionalKey(
    Schema.Struct({ agentId: AgentId, threadId: ThreadId, threadTitle: Schema.String }),
  ),
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
  Schema.TaggedStruct("SystemNotice", {
    text: Schema.String,
    /** The question whose answer this notice tells the agent; the thread shows the answer on the question. */
    questionId: Schema.optionalKey(Schema.NonEmptyString),
  }),
]);
export type InputItem = typeof InputItem.Type;

/** The batch of inputs sent to the harness as one turn. */
export const TurnInput = Schema.TaggedStruct("TurnInput", {
  items: Schema.NonEmptyArray(InputItem),
  /** The UUID the turn went to the harness with, which a fork of its session names it by. */
  turnId: Schema.optionalKey(Schema.NonEmptyString),
  /** The snapshot of a work thread's folder taken just before the turn, which a restore goes back to. */
  files: Schema.optionalKey(Schema.NonEmptyString),
});

/** The snapshot of a work thread's folder taken as one of its agents' turns ended. */
export const FilesSaved = Schema.TaggedStruct("FilesSaved", {
  snapshot: Schema.NonEmptyString,
  /** The `turnId` of the turn it ended; it is saved behind the turn, so another may have begun. */
  turnId: Schema.optionalKey(Schema.NonEmptyString),
});

/** A file one of an agent's turns changed. */
export const TurnFile = Schema.Struct({
  /** Relative to the thread's folder, with forward slashes. */
  path: Schema.NonEmptyString,
  change: withFallback(Schema.Literals(["added", "modified", "deleted"]), "modified"),
  /** Lines added and removed; absent for a file that isn't text. */
  added: Schema.optionalKey(NonNegativeInt),
  removed: Schema.optionalKey(NonNegativeInt),
  /**
   * `edit`: one of the agent's edit tools named it. `command`: none did, but a command the agent ran
   * changed it (a heredoc, `sed`, a script).
   */
  via: withFallback(Schema.Literals(["edit", "command"]), "edit"),
});
export type TurnFile = typeof TurnFile.Type;

/**
 * The files one of an agent's turns changed, found by comparing the folder's snapshots from before
 * and after it. Files another agent working in the same folder at the time may have changed are left
 * out. Recorded behind the turn, beside its `FilesSaved`.
 */
export const TurnFilesChanged = Schema.TaggedStruct("TurnFilesChanged", {
  turnId: Schema.NonEmptyString,
  /** The snapshots from before and after the turn, which a file's diff compares. */
  before: Schema.NonEmptyString,
  after: Schema.NonEmptyString,
  files: Schema.NonEmptyArray(TurnFile),
  /** Files it changed past the ones listed. */
  more: Schema.optionalKey(NonNegativeInt),
});

/**
 * The user put a turn's files back as they were before it (`undone`), or as the turn left them again
 * (`redone`). Files changed since are left as they are.
 */
export const TurnFilesReverted = Schema.TaggedStruct("TurnFilesReverted", {
  turnId: Schema.NonEmptyString,
  direction: withFallback(Schema.Literals(["undone", "redone"]), "undone"),
  /** Relative to the thread's folder, with forward slashes. */
  paths: Schema.Array(Schema.NonEmptyString),
  /** Those left as they are, as they had changed since. */
  kept: Schema.Array(Schema.NonEmptyString),
});
export type TurnFilesReverted = typeof TurnFilesReverted.Type;

/**
 * The files the thread's agents changed since one of the user's messages went back to how they were
 * before it. Recorded on the lead, beside the `ConversationRewound` that took the conversation back.
 */
export const FilesRestored = Schema.TaggedStruct("FilesRestored", {
  messageId: Schema.NonEmptyString,
  /** Relative to the thread's folder, with forward slashes. */
  paths: Schema.Array(Schema.NonEmptyString),
});

/**
 * The conversation went back to before one of the user's messages, to go on from there: this
 * agent's events from `fromSequence` up to this one are the version it replaced, kept to look back
 * on, and the agent's session no longer holds them.
 */
export const ConversationRewound = Schema.TaggedStruct("ConversationRewound", {
  fromSequence: NonNegativeInt,
  /** The user's message the conversation went back to before. */
  messageId: Schema.NonEmptyString,
  /**
   * How the session went back: `fork`, the harness's own copy of it ending there; `fresh`, a new
   * session, the message having been the first; `replay`, a new session that is told the
   * conversation so far with the next message, where the harness can't fork.
   */
  via: withFallback(Schema.Literals(["fork", "fresh", "replay"]), "replay"),
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

/**
 * The user switched the agent to another model of its harness, or another effort. Its next turn
 * runs with them; one that's running finishes on what it started with.
 */
export const ModelChanged = Schema.TaggedStruct("ModelChanged", {
  model: Schema.NonEmptyString,
  /** Absent for a model its harness offers no effort setting for. */
  effort: Schema.optionalKey(ReasoningEffort),
});

/** A spawn outside the catalog waits for the user. */
export const SpawnApprovalRequested = Schema.TaggedStruct("SpawnApprovalRequested", {
  requestId: Schema.NonEmptyString,
  role: Schema.NonEmptyString,
  provider: ProviderId,
  model: Schema.NonEmptyString,
  // What the agent would run with and be told, so the user answers knowing it; absent from requests
  // older versions made.
  effort: Schema.optionalKey(ReasoningEffort),
  access: Schema.optionalKey(AccessMode),
  prompt: Schema.optionalKey(Schema.String),
});

export const SpawnApprovalResolved = Schema.TaggedStruct("SpawnApprovalResolved", {
  requestId: Schema.NonEmptyString,
  decision: Schema.Literals(["allow", "deny"]),
});

/**
 * Cerium named the thread from its first message. Published on the lead's live
 * feed so lists refresh at once, and never stored: the thread's record holds the title.
 */
export const ThreadRenamed = Schema.TaggedStruct("ThreadRenamed", {
  title: Schema.String,
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
  TodosUpdated,
  PermissionRequested,
  PermissionResolved,
  QuestionAsked,
  QuestionResolved,
  UsageReported,
  TurnCompleted,
  AuthRequired,
  AgentError,
  TurnInput,
  ConversationRewound,
  FilesSaved,
  TurnFilesChanged,
  TurnFilesReverted,
  FilesRestored,
  MessageQueued,
  AgentSpawned,
  AgentStateChanged,
  ModelChanged,
  SpawnApprovalRequested,
  SpawnApprovalResolved,
  ThreadRenamed,
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
