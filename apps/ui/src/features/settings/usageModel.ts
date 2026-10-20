import type { MeterLevel, UsageMeter } from "@cerium/protocol";

// How Settings → Usage words and grades a harness's meters.

/** What's left of a meter, from 0 to 100. */
export const leftPercent = (meter: UsageMeter): number => Math.min(100, Math.max(0, 100 - meter.usedPercent));

/**
 * How near the meter is to its limit: the harness's own reading when it gives one, else Cerium's
 * from how much is used. A meter at or past its limit always reads critical.
 */
export const meterLevel = (meter: UsageMeter): MeterLevel =>
  meter.usedPercent >= 100
    ? "critical"
    : (meter.level ??
      (meter.usedPercent >= 90 ? "critical" : meter.usedPercent >= 75 ? "warning" : "normal"));

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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * When a meter starts again, as people say it: "Resets in 47 min" today, "Resets Tue 3:59 PM" this
 * week, "Resets Nov 17" after that.
 */
export const resetLabel = (resetsAt: number, now: number): string => {
  const wait = resetsAt - now;
  if (wait <= 0) return "Resetting now";
  if (wait < MINUTE) return "Resets in under a minute";
  if (wait < HOUR) return `Resets in ${Math.ceil(wait / MINUTE)} min`;
  if (wait < DAY) {
    const hours = Math.floor(wait / HOUR);
    const minutes = Math.floor((wait % HOUR) / MINUTE);
    return `Resets in ${hours} hr${minutes > 0 ? ` ${minutes} min` : ""}`;
  }
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
