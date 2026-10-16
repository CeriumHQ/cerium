import { Schema } from "effect";

export const ProviderId = Schema.Literals(["claude", "codex", "muse", "cursor"]);
export type ProviderId = typeof ProviderId.Type;

export const ThreadId = Schema.NonEmptyString.pipe(Schema.brand("cerium/ThreadId"));
export type ThreadId = typeof ThreadId.Type;

/** A lead or child agent: one harness session driven by Cerium. */
export const AgentId = Schema.NonEmptyString.pipe(Schema.brand("cerium/AgentId"));
export type AgentId = typeof AgentId.Type;

export const EventId = Schema.NonEmptyString.pipe(Schema.brand("cerium/EventId"));
export type EventId = typeof EventId.Type;

export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Milliseconds since the Unix epoch. Stored as-is in SQLite. */
export const EpochMillis = NonNegativeInt;
