// How Settings → Usage words a harness's meters. How a meter is graded, paced and worded is shared
// with the backend's limit warnings, so it lives in packages/protocol/src/usage.ts.
export {
  leftLabel,
  leftPercent,
  meterLevel,
  paceOf,
  resetLabel,
  runsOutLabel,
  spendLabel,
  type Pace,
} from "@cerium/protocol";

import { leftPercent, type Pace, type UsageMeter } from "@cerium/protocol";

/** What would be left now at an even pace through the window, from 0 to 100. */
export const evenLeft = (pace: Pace): number => Math.round(100 - pace.elapsed);

/** How a meter stands against an even pace: "23% to spare", "11% over pace", "On pace". */
export const paceLabel = (meter: UsageMeter, pace: Pace): string => {
  const spare = Math.round(leftPercent(meter) - (100 - pace.elapsed));
  if (spare > 0) return `${spare}% to spare`;
  if (spare < 0) return `${-spare}% over pace`;
  return "On pace";
};

/** How many of a bar's segments stay lit: a meter with anything left keeps at least one. */
export const litSegments = (meter: UsageMeter, segments: number): number => {
  const left = leftPercent(meter);
  return left > 0 ? Math.max(1, Math.round((left / 100) * segments)) : 0;
};

/** The reset's full date and time, for its tooltip: the date alone when the harness names only the day. */
export const resetMoment = (resetsAt: number, dayOnly = false): string =>
  new Date(resetsAt).toLocaleString(
    [],
    dayOnly
      ? { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }
      : { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" },
  );

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
