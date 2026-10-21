import { Schema } from "effect";

import { LenientArray } from "./compat.ts";
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
 * A harness's subscription usage, or why it couldn't be read. Harnesses signed in without a plan
 * that has limits (an API key) report nothing, so they have no entry at all.
 */
export const ProviderUsage = Schema.Union([
  Schema.TaggedStruct("Subscribed", {
    provider: ProviderId,
    /** The plan as the harness names it, e.g. "max", "plus". */
    plan: Schema.optionalKey(Schema.NonEmptyString),
    /** In the harness's order; the first is the one it treats as the headline. */
    meters: Schema.Array(UsageMeter),
    /** Free resets of the limits the plan holds, as Codex grants them; absent when it says nothing. */
    resetCredits: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    /** When the harness answered. */
    checkedAt: EpochMillis,
    /** Why the latest read failed, when these meters are the last good ones. Written for the user. */
    refreshError: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("UsageUnreadable", {
    provider: ProviderId,
    /** Written for the user. */
    message: Schema.String,
  }),
]);
export type ProviderUsage = typeof ProviderUsage.Type;

/** Every subscribed harness's usage as the backend last read it, in harness order. */
export const UsageSnapshot = Schema.Struct({
  usage: LenientArray(ProviderUsage),
  /** A read is under way, so harnesses not listed yet may still appear. */
  checking: Schema.Boolean,
});
export type UsageSnapshot = typeof UsageSnapshot.Type;

const MINUTE = 60_000;

/** Points by which use must lead the time gone before a meter counts as running fast. */
const FAST_MARGIN = 15;

/** How a meter's use compares with how much of its window has gone. */
export interface Pace {
  /** Share of the window gone, from 0 to 100. */
  readonly elapsed: number;
  /** Use leads the time gone by a clear margin. */
  readonly fast: boolean;
  /** When the meter runs out at its rate so far, if that comes before it resets. */
  readonly runsOutAt?: number;
}

/** The meter's pace, for a window whose length and reset are known and that isn't spent yet. */
export const paceOf = (meter: UsageMeter, now: number): Pace | undefined => {
  const { resetsAt, windowMinutes, usedPercent } = meter;
  if (resetsAt === undefined || windowMinutes === undefined || usedPercent >= 100) return undefined;
  const span = windowMinutes * MINUTE;
  const start = resetsAt - span;
  if (now <= start || now >= resetsAt) return undefined;
  const elapsed = ((now - start) / span) * 100;
  const runsOutAt = usedPercent > 0 ? now + ((100 - usedPercent) / usedPercent) * (now - start) : undefined;
  return {
    elapsed,
    fast: usedPercent - elapsed >= FAST_MARGIN,
    ...(runsOutAt !== undefined && runsOutAt < resetsAt ? { runsOutAt } : {}),
  };
};

const levels: ReadonlyArray<MeterLevel> = ["normal", "warning", "critical"];
const worse = (a: MeterLevel, b: MeterLevel) => (levels.indexOf(a) >= levels.indexOf(b) ? a : b);

/**
 * How near the meter is to its limit: the harness's own reading when it gives one, else Cerium's
 * from how much is used, and at least a warning while it runs fast. A meter at or past its limit
 * always reads critical.
 */
export const meterLevel = (meter: UsageMeter, pace?: Pace): MeterLevel => {
  if (meter.usedPercent >= 100) return "critical";
  const own =
    meter.level ?? (meter.usedPercent >= 90 ? "critical" : meter.usedPercent >= 75 ? "warning" : "normal");
  return pace?.fast ? worse(own, "warning") : own;
};

// How meters are worded, by Settings → Usage and by the backend's limit warnings.

const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** What's left of a meter, from 0 to 100. */
export const leftPercent = (meter: UsageMeter): number => Math.min(100, Math.max(0, 100 - meter.usedPercent));

const money = (amount: number, currency: string) => {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
};

/** The meter's headline: "92% left", "$37.50 left", "Limit reached". */
export const leftLabel = (meter: UsageMeter): string => {
  if (meter.usedPercent >= 100) return "Limit reached";
  if (meter.spend) {
    return `${money(Math.max(0, meter.spend.limit - meter.spend.used), meter.spend.currency)} left`;
  }
  const left = leftPercent(meter);
  // Nearly spent never rounds down to a limit that isn't reached yet.
  return left < 1 ? "Under 1% left" : `${Math.round(left)}% left`;
};

/** What a spending meter has spent: "$12.50 of $50.00 spent". */
export const spendLabel = ({ spend }: UsageMeter): string | undefined =>
  spend && `${money(spend.used, spend.currency)} of ${money(spend.limit, spend.currency)} spent`;

/** A wait under a day, as people say it: "under a minute", "47 min", "3 hr 12 min". */
const waitLabel = (wait: number): string => {
  if (wait < MINUTE) return "under a minute";
  if (wait < HOUR) return `${Math.ceil(wait / MINUTE)} min`;
  const hours = Math.floor(wait / HOUR);
  const minutes = Math.floor((wait % HOUR) / MINUTE);
  return `${hours} hr${minutes > 0 ? ` ${minutes} min` : ""}`;
};

/** When a running-fast meter runs out: "Runs out in ~47 min", "Runs out in ~2 days". */
export const runsOutLabel = (runsOutAt: number, now: number): string => {
  const wait = Math.max(0, runsOutAt - now);
  if (wait < DAY) return `Runs out in ~${waitLabel(wait)}`;
  const days = Math.round(wait / DAY);
  return `Runs out in ~${days} day${days === 1 ? "" : "s"}`;
};

/**
 * When a meter starts again, as people say it: "Resets in 47 min" today, "Resets Tue 3:59 PM" this
 * week, "Resets Nov 17" after that.
 */
export const resetLabel = (resetsAt: number, now: number): string => {
  const wait = resetsAt - now;
  if (wait <= 0) return "Resetting now";
  if (wait < DAY) return `Resets in ${waitLabel(wait)}`;
  const at = new Date(resetsAt);
  if (wait < 6 * DAY) {
    return `Resets ${at.toLocaleDateString([], { weekday: "short" })} ${at.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }
  return `Resets ${at.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  })}`;
};
