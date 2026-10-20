import type { MeterLevel, UsageMeter } from "@cerium/protocol";

// How Settings → Usage words and grades a harness's meters.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** What's left of a meter, from 0 to 100. */
export const leftPercent = (meter: UsageMeter): number => Math.min(100, Math.max(0, 100 - meter.usedPercent));

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

/** The reset's full date and time, for its tooltip. */
export const resetMoment = (resetsAt: number): string =>
  new Date(resetsAt).toLocaleString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** Plans whose ids don't read as their names. */
const planNames: Record<string, string> = {
  prolite: "Pro Lite",
  promax: "Pro Max",
  ent26: "Enterprise",
  enterprise_cbp_automation: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise",
  self_serve_business_prolite: "Business",
  self_serve_business_usage_based: "Business",
};

/** A plan's id as its name: "max" → "Max", "edu_plus" → "Edu Plus". */
export const planName = (plan: string): string =>
  planNames[plan] ??
  plan
    .split(/[_\s-]+/u)
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
