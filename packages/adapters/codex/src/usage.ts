import { HarnessFailure, type SubscriptionReport } from "@cerium/harness";
import type { UsageMeter } from "@cerium/protocol";
import { Effect, Option, Schema } from "effect";

import { connect } from "./rpc.ts";

// The ChatGPT plan's Codex limits, from `account/rateLimits/read`. No thread is started.

const Window = Schema.NullOr(
  Schema.Struct({
    usedPercent: Schema.Finite,
    windowDurationMins: Schema.NullOr(Schema.Finite),
    /** Unix seconds. */
    resetsAt: Schema.NullOr(Schema.Finite),
  }),
);

const Snapshot = Schema.Struct({
  limitId: Schema.NullOr(Schema.String),
  limitName: Schema.NullOr(Schema.String),
  primary: Window,
  secondary: Window,
  planType: Schema.NullOr(Schema.String),
});

/** The subset of `account/rateLimits/read` Cerium reads. The account id is never decoded. */
export const CodexRateLimits = Schema.Struct({
  rateLimits: Snapshot,
  /** Every metered bucket by its `limitId`; null from servers that report only one. */
  rateLimitsByLimitId: Schema.NullOr(Schema.Record(Schema.String, Snapshot)),
});
export type CodexRateLimits = typeof CodexRateLimits.Type;
const decodeRateLimits = Schema.decodeUnknownEffect(CodexRateLimits);

/** The bucket every Codex model draws from; others are named for the models they meter. */
const MAIN_BUCKET = "codex";
/** Plans without a subscription behind them. */
const UNSUBSCRIBED = new Set(["free", "unknown"]);

const DAY = 24 * 60;

/** A window's length as Codex names it: "5-hour limit", "Weekly limit". */
export const windowLabel = (minutes: number | null): string => {
  if (minutes === null || minutes <= 0) return "Usage limit";
  if (minutes === 7 * DAY) return "Weekly limit";
  if (minutes === DAY) return "Daily limit";
  if (minutes >= 28 * DAY && minutes <= 31 * DAY) return "Monthly limit";
  if (minutes % DAY === 0) return `${minutes / DAY}-day limit`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
};

const toMeters = (snapshot: typeof Snapshot.Type): ReadonlyArray<UsageMeter> => {
  const bucket =
    snapshot.limitId === null || snapshot.limitId === MAIN_BUCKET
      ? undefined
      : (snapshot.limitName ?? snapshot.limitId);
  return [snapshot.primary, snapshot.secondary].flatMap((window) => {
    if (window === null) return [];
    const minutes = window.windowDurationMins;
    const label = windowLabel(minutes);
    return [
      {
        label: bucket === undefined ? label : `${label} · ${bucket}`,
        usedPercent: Math.max(0, window.usedPercent),
        ...(window.resetsAt === null || window.resetsAt < 0
          ? {}
          : { resetsAt: Math.round(window.resetsAt * 1000) }),
        ...(minutes === null || minutes <= 0 ? {} : { windowMinutes: Math.round(minutes) }),
      },
    ];
  });
};

/** The plan's meters, main bucket first; `None` for a free plan or an API key. */
export const toCodexReport = (limits: CodexRateLimits): Option.Option<SubscriptionReport> => {
  const plan = limits.rateLimits.planType;
  if (plan === null || UNSUBSCRIBED.has(plan)) return Option.none();
  const buckets = Object.values(limits.rateLimitsByLimitId ?? {}).filter((each) => each !== undefined);
  const ordered = buckets.length === 0 ? [limits.rateLimits] : buckets;
  const main = ordered.filter((each) => each.limitId === null || each.limitId === MAIN_BUCKET);
  const rest = ordered.filter((each) => !main.includes(each));
  return Option.some({ plan, meters: [...main, ...rest].flatMap(toMeters) });
};

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "codex", message, cause });

/** Asks the user's `codex` how much of its plan's limits are used. */
export const readCodexUsage = Effect.fn("CodexAdapter.usage")(function* (executablePath: string) {
  const server = yield* connect(executablePath);
  const response = yield* server
    .request("account/rateLimits/read", { excludeResetCreditDetails: true })
    .pipe(Effect.mapError(failure("Could not read Codex's usage")));
  const limits = yield* decodeRateLimits(response).pipe(
    Effect.mapError(failure("Unexpected `account/rateLimits/read` response")),
  );
  return toCodexReport(limits);
}, Effect.scoped);
