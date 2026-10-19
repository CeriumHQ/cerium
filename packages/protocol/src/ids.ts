import { Schema } from "effect";

export const ProviderId = Schema.Literals(["claude", "codex", "muse", "cursor"]);
export type ProviderId = typeof ProviderId.Type;

/**
 * The harnesses this build offers, in display order. Muse is off until `muse serve` runs sandboxed
 * commands on Windows; its id stays valid so threads it ran still load.
 */
export const OFFERED_PROVIDERS: ReadonlyArray<ProviderId> = ["claude", "codex", "cursor"];

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

/** One machine or browser linked to a Cerium account. */
export const DeviceId = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)).pipe(
  Schema.brand("cerium/DeviceId"),
);
export type DeviceId = typeof DeviceId.Type;
