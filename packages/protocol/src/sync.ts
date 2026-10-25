import { Schema, Struct } from "effect";

import { LenientArray, Skippable } from "./compat.ts";
import { AgentEvent } from "./events.ts";
import { DeviceId, EpochMillis, NonNegativeInt, ThreadId } from "./ids.ts";
import { AgentInfo, ThreadInfo } from "./orchestration.ts";

// Synced threads: every machine keeps a copy of its threads in the account's cloud, so every device
// sees every thread, and can read one whose machine is offline.

/**
 * An event as the UI and the cloud copy see it. The provider's original message stays in the store:
 * the UI never reads it, and it isn't always strict JSON (SDKs leave `undefined` fields in), which
 * would fail the whole response. Encoding drops keys a struct doesn't declare.
 */
export const UiEvent = AgentEvent.mapFields(Struct.omit(["raw"]));
export type UiEvent = typeof UiEvent.Type;

/** A thread's events, skipping those of kinds this version doesn't know. */
export const UiEvents = LenientArray(UiEvent);

/** A live event, read as `undefined` when it's of a kind this version doesn't know. */
export const LiveUiEvent = Skippable(UiEvent);

/** What the inbox needs about one thread. */
export const ThreadOverview = Schema.Struct({
  thread: ThreadInfo,
  agents: Schema.Array(AgentInfo),
  awaitingApproval: Schema.Boolean,
});
export type ThreadOverview = typeof ThreadOverview.Type;

/** Threads, skipping any this version can't read, such as one led by a provider it doesn't know. */
export const ThreadOverviews = LenientArray(ThreadOverview);

/** A thread of the account, with the machine it lives on. */
export const AccountThread = Schema.Struct({ machine: DeviceId, overview: ThreadOverview });
export type AccountThread = typeof AccountThread.Type;

/** The account's threads, skipping any this version can't read. */
const AccountThreadList = LenientArray(AccountThread);

/** When a thread was last seen, on any of the account's devices, by its last activity then. */
export const ReadEntry = Schema.Struct({ threadId: ThreadId, seenAt: EpochMillis });
export type ReadEntry = typeof ReadEntry.Type;

/** Every thread of the account and what has been seen of them, as a device knows them. */
export const AccountThreads = Schema.Struct({
  threads: AccountThreadList,
  read: Schema.Array(ReadEntry),
});
export type AccountThreads = typeof AccountThreads.Type;

/**
 * A message being written, as the account's devices share it: keyed by its thread's id, or
 * `new:<uuid>` for a thread not started yet, and gone (`draft` absent) once sent, emptied or
 * discarded. The most recent edit wins. Its content is the UI's to read, so a version that writes
 * something new into it never makes another version's relay or device drop the message.
 */
export const DraftEntry = Schema.Struct({
  key: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
  updatedAt: EpochMillis,
  draft: Schema.optionalKey(Schema.Json),
});
export type DraftEntry = typeof DraftEntry.Type;

/**
 * The account's drafts as a device knows them: `ready` once the relay sent them since this
 * device last connected, before which the list may be missing some.
 */
export const AccountDrafts = Schema.Struct({ ready: Schema.Boolean, drafts: Schema.Array(DraftEntry) });
export type AccountDrafts = typeof AccountDrafts.Type;

/** The relay keeps a draft only while its content stays under this size. */
export const MAX_DRAFT_BYTES = 256_000;

/**
 * One of the user's own tasks (the rail's Tasks), as the account's devices share it: keyed by an id
 * its device made, and gone (`task` absent) once deleted. The most recent edit wins. Like a draft's,
 * its content is the UI's to read, so the relay keeps whatever a newer version writes into it.
 */
export const TaskEntry = Schema.Struct({
  id: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  updatedAt: EpochMillis,
  task: Schema.optionalKey(Schema.Json),
});
export type TaskEntry = typeof TaskEntry.Type;

/**
 * The account's tasks as a device knows them: `ready` once the relay sent them since this device
 * last connected, before which the list may be missing some.
 */
export const AccountTasks = Schema.Struct({ ready: Schema.Boolean, tasks: Schema.Array(TaskEntry) });
export type AccountTasks = typeof AccountTasks.Type;

/** The relay keeps a task only while its content stays under this size. */
export const MAX_TASK_BYTES = 32_000;

/** Streamed text isn't kept in the cloud copy: each stream ends in a completed event that holds it all. */
export const isStreamDelta = (tag: string) => tag === "MessageDelta" || tag === "ReasoningDelta";

/** What a desktop sends its relay socket to keep the cloud copy current. */
export const SyncMessage = Schema.Union([
  /** These threads of the sender, new or changed. */
  Schema.TaggedStruct("SyncThreads", { threads: ThreadOverviews }),
  /** These threads of the sender are gone. */
  Schema.TaggedStruct("SyncRemoved", { threadIds: Schema.Array(ThreadId) }),
  /**
   * A thread's events from position `start` on, in the order the machine stored them. The relay
   * keeps what follows what it has, and answers `SyncAccepted` with how many it has now. Strict,
   * unlike other lists of events: a skipped event would throw the counts off.
   */
  Schema.TaggedStruct("SyncEvents", {
    threadId: ThreadId,
    start: NonNegativeInt,
    events: Schema.Array(UiEvent),
  }),
  /** The user saw these threads, on this device. */
  Schema.TaggedStruct("MarkRead", { entries: Schema.Array(ReadEntry) }),
  /** Drafts written, sent or discarded on this device. */
  Schema.TaggedStruct("SaveDrafts", { drafts: Schema.Array(DraftEntry) }),
  /** Tasks added, changed or deleted on this device. A relay before tasks drops it unread. */
  Schema.TaggedStruct("SaveTasks", { tasks: Schema.Array(TaskEntry) }),
]);
export type SyncMessage = typeof SyncMessage.Type;

/** What the relay tells devices about the cloud copy. */
export const SyncNotice = Schema.Union([
  /** On connecting, to a desktop: how many events of each of its threads the cloud has. */
  Schema.TaggedStruct("SyncCursors", { threads: Schema.Record(ThreadId, NonNegativeInt) }),
  /** After `SyncEvents`: how many of the thread's events the cloud has now. */
  Schema.TaggedStruct("SyncAccepted", { threadId: ThreadId, count: NonNegativeInt }),
  /** On connecting: every thread of the account, and what has been seen. */
  Schema.TaggedStruct("AccountThreads", {
    threads: AccountThreadList,
    read: Schema.Array(ReadEntry),
  }),
  /** Threads that changed or went, on another machine. */
  Schema.TaggedStruct("ThreadsChanged", {
    threads: AccountThreadList,
    removed: Schema.Array(Schema.Struct({ machine: DeviceId, threadId: ThreadId })),
  }),
  /** Threads seen on some device. */
  Schema.TaggedStruct("ReadChanged", { entries: Schema.Array(ReadEntry) }),
  /** On connecting: every draft of the account, gone ones included for a while. */
  Schema.TaggedStruct("AccountDrafts", { drafts: Schema.Array(DraftEntry) }),
  /**
   * Drafts changed on another connection; or, to the one that sent them, the newer drafts its
   * edits lost to.
   */
  Schema.TaggedStruct("DraftsChanged", { drafts: Schema.Array(DraftEntry) }),
  /** On connecting: every task of the account, deleted ones included for a while. */
  Schema.TaggedStruct("AccountTasks", { tasks: Schema.Array(TaskEntry) }),
  /**
   * Tasks changed on another connection; or, to the one that sent them, the newer tasks its edits
   * lost to.
   */
  Schema.TaggedStruct("TasksChanged", { tasks: Schema.Array(TaskEntry) }),
]);
export type SyncNotice = typeof SyncNotice.Type;

/** The relay keeps each stored batch of events under this size: SQLite rows top out at 2 MB. */
export const MAX_SYNC_BATCH_BYTES = 900_000;
