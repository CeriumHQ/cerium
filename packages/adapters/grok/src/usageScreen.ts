import type { SubscriptionReport } from "@cerium/harness";
import type { UsageMeter } from "@cerium/protocol";

// The Grok Build CLI's `/usage` panel, read off its screen:
//
//   ┌─────────────────────────────────────────────────────────────────────── [✗] ─┐
//   │  Context usage  Usage limit  Session info                                   │
//   │─────────────────────────────────────────────────────────────────────────────│
//   │  Weekly limit (SuperGrok)                                                   │
//   │                                                                             │
//   │  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  1%                                         │
//   │  Resets: November 27, 04:13                                                 │
//   │                                                                             │
//   │  Tab switch  |  ↑/↓ scroll  |  c copy session ID  |  Esc close              │
//   └─────────────────────────────────────────────────────────────────────────────┘

export type GrokUsageScreen =
  | { readonly _tag: "Waiting" }
  | { readonly _tag: "Trust" }
  | { readonly _tag: "Prompt" }
  | { readonly _tag: "Offered" }
  | { readonly _tag: "Report"; readonly report: SubscriptionReport }
  | { readonly _tag: "NoPlan" }
  | { readonly _tag: "LoggedOut" };

const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const windowMinutesOf = (label: string): number | undefined => {
  const lower = label.toLowerCase();
  if (lower.includes("weekly")) return WEEK_MINUTES;
  if (lower.includes("daily")) return DAY_MINUTES;
  const hours = /(\d+)\s*-?\s*hour/u.exec(lower);
  if (hours) return Number(hours[1]) * 60;
  const days = /(\d+)\s*-?\s*day/u.exec(lower);
  if (days) return Number(days[1]) * DAY_MINUTES;
  return undefined;
};

/**
 * Parses a reset timestamp as Grok Build displays it, e.g. "November 27, 04:13",
 * "Nov 27, 4:13 PM", ISO 8601, or a relative countdown "in 2h 15m".
 */
export const parseGrokReset = (raw: string, now: number): number | undefined => {
  const text = raw.trim();
  if (text === "") return undefined;

  // ISO 8601
  if (/^\d{4}-\d{2}-\d{2}T/u.test(text)) {
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : undefined;
  }

  // Relative duration: "in 2h 15m", "in 45m", "in 3d 4h"
  const relative = /^in\s+(.+)$/iu.exec(text);
  if (relative) {
    let deltaMs = 0;
    let matched = false;
    for (const part of relative[1]!.matchAll(
      /(\d+)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs)/giu,
    )) {
      const n = Number(part[1]);
      const unit = part[2]!.toLowerCase();
      if (unit.startsWith("d")) deltaMs += n * 86_400_000;
      else if (unit.startsWith("h")) deltaMs += n * 3_600_000;
      else if (unit.startsWith("m")) deltaMs += n * 60_000;
      else deltaMs += n * 1_000;
      matched = true;
    }
    return matched ? Math.round(now + deltaMs) : undefined;
  }

  // "November 27, 04:13" or "Nov 27, 2026, 4:13 PM"
  const dateTime = /^([A-Za-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?,?\s+(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/iu.exec(
    text,
  );
  if (dateTime) {
    const month = MONTHS[dateTime[1]!.toLowerCase()];
    if (month === undefined) return undefined;
    const day = Number(dateTime[2]);
    const explicitYear = dateTime[3] ? Number(dateTime[3]) : undefined;
    let hour = Number(dateTime[4]);
    const minute = Number(dateTime[5]);
    const meridiem = dateTime[6]?.toUpperCase();
    if (meridiem === "PM" && hour < 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;

    if (explicitYear !== undefined) {
      const at = new Date(explicitYear, month, day, hour, minute, 0, 0).getTime();
      return Number.isFinite(at) && at >= 0 ? at : undefined;
    }
    const baseYear = new Date(now).getFullYear();
    for (const year of [baseYear, baseYear + 1]) {
      const candidate = new Date(year, month, day, hour, minute, 0, 0).getTime();
      if (Number.isFinite(candidate) && candidate >= now - 86_400_000) return candidate;
    }
  }
  return undefined;
};

/** Extracts the interior lines of the modal box (`│ ... │`). */
const panelLines = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  const inside: Array<string> = [];
  for (const line of lines) {
    const match = /│(.*)│/u.exec(line);
    if (match) inside.push(match[1]!.trim());
  }
  return inside;
};

const METER_HEADER = /^([A-Za-z0-9 -]+\blimit)\s*(?:\(([^)]+)\))?$/iu;
const BAR_PERCENT = /^[░▒▓█\s]+(\d+(?:\.\d+)?)%$/u;
const RESETS_LINE = /^Resets?:\s+(.+)$/iu;

const parsePanel = (lines: ReadonlyArray<string>, now: number): SubscriptionReport | "noPlan" | undefined => {
  const content = panelLines(lines);
  if (content.length === 0) return undefined;

  let plan: string | undefined;
  const meters: Array<UsageMeter> = [];

  for (let i = 0; i < content.length; i++) {
    const header = METER_HEADER.exec(content[i]!);
    if (!header) continue;
    const label = header[1]!.trim();
    const tier = header[2]?.trim();
    if (tier && plan === undefined) plan = tier;

    // Look ahead within the next few lines for the percentage bar and optional reset time.
    let usedPercent: number | undefined;
    let resetsAt: number | undefined;
    for (let j = i + 1; j < Math.min(content.length, i + 6); j++) {
      const candidate = content[j]!;
      if (METER_HEADER.test(candidate)) break;
      const bar = BAR_PERCENT.exec(candidate);
      if (bar && usedPercent === undefined) {
        usedPercent = Number(bar[1]);
        continue;
      }
      const reset = RESETS_LINE.exec(candidate);
      if (reset && resetsAt === undefined) {
        resetsAt = parseGrokReset(reset[1]!, now);
      }
    }
    if (usedPercent !== undefined && Number.isFinite(usedPercent)) {
      const windowMinutes = windowMinutesOf(label);
      meters.push({
        label,
        usedPercent: Math.max(0, usedPercent),
        ...(resetsAt === undefined ? {} : { resetsAt }),
        ...(windowMinutes === undefined ? {} : { windowMinutes }),
      });
    }
  }

  if (meters.length > 0) {
    return { ...(plan === undefined ? {} : { plan }), meters };
  }
  const joined = content.join("\n");
  if (/no usage limit|api key|not available|no active subscription|pay-as-you-go/iu.test(joined)) {
    return "noPlan";
  }
  return undefined;
};

/** Interprets the Grok Build CLI's current terminal screen. */
export const readGrokUsageScreen = (screen: string, now: number): GrokUsageScreen => {
  const lines = screen.split(/\r?\n/u).map((line) => line.trimEnd());
  const text = lines.join("\n");

  if (text.includes("Do you trust the contents of this directory?")) {
    return { _tag: "Trust" };
  }
  if (/Sign in to Grok|Run `grok login`|Not logged in/iu.test(text)) {
    return { _tag: "LoggedOut" };
  }
  if (text.includes("Usage limit") && text.includes("Esc close")) {
    const parsed = parsePanel(lines, now);
    if (parsed === "noPlan") return { _tag: "NoPlan" };
    if (parsed !== undefined) return { _tag: "Report", report: parsed };
    return { _tag: "Waiting" };
  }
  if (/❯\s+\/usage\s+View usage/u.test(text)) {
    return { _tag: "Offered" };
  }
  if (/│\s*❯\s/u.test(text)) {
    return { _tag: "Prompt" };
  }
  return { _tag: "Waiting" };
};
