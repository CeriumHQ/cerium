import { CONTEXT_KEYS } from "./scrub.ts";

// A failure another of Cerium's processes hands the shell to report (crashReports.ts): the UI's over
// the preload bridge, the backend's over its parent port (apps/backend/src/reports.ts).

/** What part of Cerium a report is about. */
export type ReportCategory = "render" | "uncaught" | "startup" | "crash" | "harness" | "relay" | "update";

const CATEGORIES: ReadonlySet<string> = new Set([
  "render",
  "uncaught",
  "startup",
  "crash",
  "harness",
  "relay",
  "update",
]);

export interface CrashReport {
  readonly process: "main" | "renderer" | "backend";
  readonly category: ReportCategory;
  /** What failed within the category: a backend failure's kind, a harness session's phase, … */
  readonly kind?: string;
  /** The error's name, its message and its stack, as the process that threw it had them. */
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  /** A few named facts about the failure (`CONTEXT_KEYS`): the harness, the phase, a status code. */
  readonly context?: Readonly<Record<string, string | number | boolean>>;
}

/** The longest stack a report takes in, before Sentry parses its frames. */
const STACK_LIMIT = 16_000;

const shortString = (value: unknown, limit: number): string | undefined =>
  typeof value === "string" && value !== "" ? value.slice(0, limit) : undefined;

/**
 * A report another process sent, if it is one; `process` is where it came from, whatever it says.
 * Context keys outside `CONTEXT_KEYS` are dropped here already.
 */
export const asCrashReport = (value: unknown, process: CrashReport["process"]): CrashReport | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const category = raw["category"];
  if (typeof category !== "string" || !CATEGORIES.has(category)) return undefined;
  const name = shortString(raw["name"], 120) ?? "Error";
  const message = shortString(raw["message"], 2_000) ?? "";
  const kind = shortString(raw["kind"], 64);
  const stack = shortString(raw["stack"], STACK_LIMIT);
  const context =
    typeof raw["context"] === "object" && raw["context"] !== null
      ? Object.fromEntries(
          Object.entries(raw["context"]).filter(
            ([key, entry]) => CONTEXT_KEYS.has(key) && ["string", "number", "boolean"].includes(typeof entry),
          ) as Array<[string, string | number | boolean]>,
        )
      : undefined;
  return {
    process,
    category: category as ReportCategory,
    name,
    message,
    ...(kind === undefined ? {} : { kind }),
    ...(stack === undefined ? {} : { stack }),
    ...(context === undefined || Object.keys(context).length === 0 ? {} : { context }),
  };
};

/** How long the same failure stays quiet once reported, and how many reports one run sends at most. */
const QUIET_MS = 10 * 60_000;
const PER_RUN = 30;

/**
 * Whether a report may go now: the same failure (`key`) once per `QUIET_MS`, and no more than
 * `PER_RUN` in all, so a failure that repeats in a loop sends one report, not hundreds.
 */
export const reportLimiter = (quietMs = QUIET_MS, perRun = PER_RUN) => {
  const sent = new Map<string, number>();
  let count = 0;
  return (key: string, now: number): boolean => {
    const last = sent.get(key);
    if (count >= perRun || (last !== undefined && now - last < quietMs)) return false;
    sent.set(key, now);
    count += 1;
    return true;
  };
};

/** The error Sentry is given for a report, its stack the one the reporting process had. */
export const errorOf = (report: CrashReport): Error => {
  const error = new Error(report.message);
  error.name = report.name;
  if (report.stack !== undefined) error.stack = report.stack;
  else delete error.stack;
  return error;
};

/**
 * What groups a report with the same failure on other machines: Sentry's own grouping, by the stack
 * where there is one, kept apart per process, category and kind.
 */
export const fingerprintOf = (report: CrashReport): Array<string> => [
  "{{ default }}",
  report.process,
  report.category,
  report.kind ?? "-",
];

/** Which reports count as the same failure for `reportLimiter`. */
export const limitKeyOf = (report: CrashReport): string =>
  [report.process, report.category, report.kind ?? "-", report.name, report.message.slice(0, 80)].join("|");
