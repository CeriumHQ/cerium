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
]);
export type SyncNotice = typeof SyncNotice.Type;

/** The relay keeps each stored batch of events under this size: SQLite rows top out at 2 MB. */
export const MAX_SYNC_BATCH_BYTES = 900_000;
