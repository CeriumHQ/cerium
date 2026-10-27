import { Cause, Logger, References } from "effect";

// Failures the backend hands the desktop shell for its anonymous crash reports
// (apps/desktop/src/crashReports.ts), which scrubs and sends them. Any package reports one by
// logging it with a `report` annotation naming its category, and the facts that place it as further
// annotations:
//
//   Effect.logError("Agent session failed", cause).pipe(
//     Effect.annotateLogs({ report: "harness", harness: provider, phase: "session" }))
//
// Only the annotations in `CONTEXT_KEYS` go along; the log line itself still goes to backend.log.

/** The annotation that marks a log as a report, its value the category. */
export const REPORT = "report";

/** The categories the backend reports in. */
const CATEGORIES: ReadonlySet<string> = new Set(["startup", "crash", "harness", "relay"]);
/** The annotations a report carries along, mirrored by the shell's own list. */
const CONTEXT_KEYS = ["harness", "phase", "code", "status"] as const;

/** A report as the shell receives it over the utility process's parent port. */
export interface CrashReportMessage {
  readonly _tag: "CrashReport";
  readonly category: string;
  readonly kind?: string;
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly context?: Readonly<Record<string, string | number | boolean>>;
}

/** Failures that are the user's machine's state to fix, which no report would help with. */
const EXPECTED: ReadonlySet<string> = new Set(["HarnessUnavailable"]);

const tagOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && typeof (error as { _tag?: unknown })._tag === "string"
    ? (error as { _tag: string })._tag
    : undefined;

/** The report for `error` in `category`. */
export const crashReport = (
  category: string,
  error: unknown,
  extra: { readonly kind?: string; readonly context?: CrashReportMessage["context"] } = {},
): CrashReportMessage => {
  const failure = error instanceof Error ? error : undefined;
  const tag = tagOf(error);
  return {
    _tag: "CrashReport",
    category,
    name: tag ?? failure?.name ?? "Error",
    message: failure?.message ?? (typeof error === "string" ? error : ""),
    ...(failure?.stack === undefined ? {} : { stack: failure.stack }),
    ...(extra.kind === undefined ? {} : { kind: extra.kind }),
    ...(extra.context === undefined ? {} : { context: extra.context }),
  };
};

/** The log's own words when it carries no error. */
const textOf = (message: unknown): string =>
  (Array.isArray(message) ? message : [message])
    .filter((part): part is string | number | boolean =>
      ["string", "number", "boolean"].includes(typeof part),
    )
    .join(" ");

/** A logger that hands `post` every log annotated as a report, and nothing else. */
export const reportLogger = (post: (report: CrashReportMessage) => void) =>
  Logger.make<unknown, void>((options) => {
    const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
    const category = annotations[REPORT];
    if (typeof category !== "string" || !CATEGORIES.has(category)) return;
    const context = Object.fromEntries(
      CONTEXT_KEYS.flatMap((key) => {
        const value = annotations[key];
        return ["string", "number", "boolean"].includes(typeof value)
          ? [[key, value as string | number | boolean]]
          : [];
      }),
    );
    const kind = annotations["kind"];
    const failed = Cause.hasFails(options.cause) || Cause.hasDies(options.cause);
    // A session stopped on purpose ends interrupted; that's no failure.
    if (!failed && Cause.hasInterrupts(options.cause)) return;
    const error = failed ? Cause.squash(options.cause) : new Error(textOf(options.message));
    if (EXPECTED.has(tagOf(error) ?? "")) return;
    post(
      crashReport(category, error, {
        ...(typeof kind === "string" ? { kind } : {}),
        ...(Object.keys(context).length === 0 ? {} : { context }),
      }),
    );
  });
