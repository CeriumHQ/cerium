import { Schema } from "effect";

import { EpochMillis, ProviderId } from "./ids.ts";

// A subscription's usage limits as each harness reports them, for Settings → Usage. Cerium shows
// the harness's numbers and never estimates its own.

/** How near a meter is to its limit: the provider's reading when it gives one. */
export const MeterLevel = Schema.Literals(["normal", "warning", "critical"]);
export type MeterLevel = typeof MeterLevel.Type;

/** What a spending meter has spent and may spend, in the currency's major units (dollars). */
export const MeterSpend = Schema.Struct({
  used: Schema.Finite,
  limit: Schema.Finite,
  /** ISO 4217, e.g. "USD". */
  currency: Schema.NonEmptyString,
});
export type MeterSpend = typeof MeterSpend.Type;

/** One of a subscription's meters: a window of usage that resets, or a monthly spending cap. */
export const UsageMeter = Schema.Struct({
  /** As people say it: "Current session", "Weekly", "Weekly · Opus". */
  label: Schema.NonEmptyString,
  /** Share of the limit used, from 0; past 100 once it is over. */
  usedPercent: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  /** When the window starts again. */
  resetsAt: Schema.optionalKey(EpochMillis),
  /** The window's length, when the harness says. */
  windowMinutes: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
  level: Schema.optionalKey(MeterLevel),
  spend: Schema.optionalKey(MeterSpend),
});
export type UsageMeter = typeof UsageMeter.Type;

/**
 * A harness's subscription usage, or why it couldn't be read. Harnesses signed in without a
 * subscription (an API key, a free plan) report nothing, so they have no entry at all.
 */
export const ProviderUsage = Schema.Union([
  Schema.TaggedStruct("Subscribed", {
    provider: ProviderId,
    /** The plan as the harness names it, e.g. "max", "plus". */
    plan: Schema.optionalKey(Schema.NonEmptyString),
    /** In the harness's order; the first is the one it treats as the headline. */
    meters: Schema.Array(UsageMeter),
    /** When the harness answered. */
    checkedAt: EpochMillis,
  }),
  Schema.TaggedStruct("UsageUnreadable", {
    provider: ProviderId,
    /** Written for the user. */
    message: Schema.String,
  }),
]);
export type ProviderUsage = typeof ProviderUsage.Type;
