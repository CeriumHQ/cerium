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
