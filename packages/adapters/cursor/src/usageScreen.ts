import type { SubscriptionReport } from "@cerium/harness";
import { compareVersions } from "@cerium/harness";
import type { UsageMeter } from "@cerium/protocol";

// The Cursor CLI's `/usage` panel, read off its screen. The CLI asks Cursor for the plan's usage with
// its own login and draws it; Cerium reads only what the panel shows. The panel lays itself out by
// width, so the CLI runs in a terminal wide enough for its table:
//
//   Usage • Premium                                              Resets Oct 30
//   Monthly plan and on-demand usage
//   Category        Current             Usage
//   Included        15% used            ████████████░░░░░░░░░░░░░░░░░░░░░░░░░░
//     Auto          15% used            ████████████░░░░░░░░░░░░░░░░░░░░░░░░░░
//     API           0% used             ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
//   On-Demand       $12.50 / $50        █████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
//
//   $37.50 remaining
//   ...
//   Esc to close

/** The first CLI version with `/usage`. */
export const MIN_USAGE_VERSION = "2026.7.13";

/** What the screen shows so far. */
export type UsageScreen =
  /** Still starting, or still loading the panel. */
  | { readonly _tag: "Waiting" }
  /** The CLI's prompt is up, ready for `/usage`. */
  | { readonly _tag: "Prompt"; readonly version?: string }
  /** `/usage` is offered in the command menu, ready to run. */
  | { readonly _tag: "Offered" }
  | { readonly _tag: "Report"; readonly report: SubscriptionReport }
  /** The plan has no usage the CLI can show. */
  | { readonly _tag: "NoPlan" }
  | { readonly _tag: "LoggedOut" }
  | { readonly _tag: "Failed"; readonly message: string };

const SPEND_SUBTITLE = "Personal spend for the current billing period";
const PLAN_SUBTITLE = "Monthly plan and on-demand usage";

const percentRow = (lines: ReadonlyArray<string>, label: string): number | undefined => {
  const pattern = new RegExp(`^\\s*${label}\\s+(\\d+(?:\\.\\d+)?)% used`, "u");
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) return Number(match[1]);
  }
  return undefined;
};

/** Dollars as the CLI writes them: "$0", "$12.50", "$1,234.56". */
const dollars = (text: string): ReadonlyArray<number> =>
  [...text.matchAll(/\$([\d,]+(?:\.\d+)?)/gu)].map((match) => Number(match[1]!.replaceAll(",", "")));

/** The on-demand cap, when the plan has a monthly one: what is spent and what may be. */
const onDemandCap = (lines: ReadonlyArray<string>): { used: number; limit: number } | undefined => {
  const row = lines.find((line) => /^\s*On-Demand\s/u.test(line));
  const remainingLine = lines.find((line) => /^\s*\$[\d,.]+ remaining\s*$/u.test(line));
  if (row === undefined || remainingLine === undefined) return undefined;
  // The value column cuts a long "$1,234.56 / $5,000" short, with an ellipsis; what's left is written
  // in full below it.
  const value = row.replace(/^\s*On-Demand\s+/u, "").split(/\s{2,}|[█░─—-]{2,}/u)[0] ?? "";
  const [used, stated] = dollars(value);
  const [remaining] = dollars(remainingLine);
  if (used === undefined || remaining === undefined) return undefined;
  return { used, limit: stated !== undefined && !value.includes("…") ? stated : used + remaining };
};

const normalized = (text: string) => text.replaceAll(/\s+/gu, " ").trim();

/**
 * The day a "Resets Oct 30" label names, as that day's start in UTC: the CLI writes the billing
 * cycle's end as a UTC date in the machine's locale, with no year, so it is the next such day.
 */
export const resetDay = (
  label: string,
  now: number,
  locales: ReadonlyArray<string | undefined> = [undefined, "en-US"],
): number | undefined => {
  const wanted = normalized(label.replace(/^\s*Resets\s+/u, ""));
  if (wanted === "" || wanted === normalized(label)) return undefined;
  const formats = locales.map(
    (locale) => new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", timeZone: "UTC" }),
  );
  const today = new Date(now);
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1);
  for (let offset = 0; offset <= 400; offset++) {
    const day = start + offset * 86_400_000;
    if (formats.some((format) => normalized(format.format(day)) === wanted)) return day;
  }
  return undefined;
};

/** The plan name and reset label from the panel's title line, "Usage • Premium     Resets Oct 30". */
const titleOf = (lines: ReadonlyArray<string>, subtitle: number) => {
  for (let index = subtitle - 1; index >= 0 && index >= subtitle - 3; index--) {
    const match = /^\s*Usage\s+\S\s+(.*)$/u.exec(lines[index]!);
    if (!match) continue;
    const [plan, reset] = match[1]!.trim().split(/\s{2,}/u);
    return { plan: plan?.trim() || undefined, reset: reset?.trim() };
  }
  return { plan: undefined, reset: undefined };
};

const reportOf = (lines: ReadonlyArray<string>, subtitle: number, now: number): SubscriptionReport => {
  const { plan, reset } = titleOf(lines, subtitle);
  const plans = plan === undefined || plan === "Current plan" ? {} : { plan };
  if (lines[subtitle]!.includes(SPEND_SUBTITLE)) return { ...plans, meters: [] };

  const resetsAt = reset === undefined ? undefined : resetDay(reset, now);
  const resets = resetsAt === undefined ? {} : { resetsAt, resetDayOnly: true };
  const body = lines.slice(subtitle + 1);
  const pools: ReadonlyArray<UsageMeter> = (
    [
      ["Included · Auto", percentRow(body, "Auto")],
      ["Included · API", percentRow(body, "API")],
    ] as const
  ).flatMap(([label, usedPercent]) => (usedPercent === undefined ? [] : [{ label, usedPercent, ...resets }]));
  const cap = onDemandCap(body);
  const onDemand: ReadonlyArray<UsageMeter> =
    cap === undefined || cap.limit <= 0
      ? []
      : [
          {
            label: "On-demand",
            usedPercent: (cap.used / cap.limit) * 100,
            ...resets,
            spend: { used: cap.used, limit: cap.limit, currency: "USD" },
          },
        ];
  return { ...plans, meters: [...pools, ...onDemand] };
};

/** Reads the CLI's screen, given as its lines of text. */
export const readUsageScreen = (screen: string, now: number): UsageScreen => {
  const lines = screen.split(/\r?\n/u).map((line) => line.trimEnd());
  const text = lines.join("\n");

  const subtitle = lines.findIndex((line) => line.includes(PLAN_SUBTITLE) || line.includes(SPEND_SUBTITLE));
  if (subtitle >= 0) {
    // The panel draws its rows in one frame, but a frame can be read half-drawn.
    if (!text.includes("Esc to close")) return { _tag: "Waiting" };
    return { _tag: "Report", report: reportOf(lines, subtitle, now) };
  }
  if (text.includes("Not logged in. Run /login first.")) return { _tag: "LoggedOut" };
  if (/are not available for this (?:plan|account) in the CLI/u.test(text)) return { _tag: "NoPlan" };
  const failed = lines.findIndex((line) => line.includes("Failed to load usage data:"));
  if (failed >= 0) {
    const reason = lines[failed + 1]?.trim();
    return {
      _tag: "Failed",
      message: reason ? `Cursor couldn't load its usage: ${reason}` : "Cursor couldn't load its usage.",
    };
  }
  if (text.includes("Loading usage data...")) return { _tag: "Waiting" };
  if (/^\s*→ \/usage\s+Show plan and on-demand usage/mu.test(text)) return { _tag: "Offered" };
  if (/^\s*→ /mu.test(text)) {
    const version = /^\s*v(\d+\.\d+\.\d+)/mu.exec(text)?.[1];
    return version === undefined ? { _tag: "Prompt" } : { _tag: "Prompt", version };
  }
  return { _tag: "Waiting" };
};

/** Whether this CLI version has `/usage`. */
export const hasUsageCommand = (version: string): boolean => compareVersions(version, MIN_USAGE_VERSION) >= 0;
