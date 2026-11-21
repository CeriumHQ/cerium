import { HarnessFailure, type SubscriptionReport } from "@cerium/harness";
import type { UsageMeter } from "@cerium/protocol";
import { Effect, Option, Schema } from "effect";

import { openHost, query, type MuseHost } from "./host.ts";

// Muse Code's subscription allowance, from MSP `usage/refresh` (with `usage/read` fallback on older
// hosts). Runs without starting a session or spending a model turn.

const UsageWindow = Schema.Struct({
  usedPercent: Schema.Finite,
  resetsAtMs: Schema.Finite,
  windowDurationMins: Schema.Finite,
});

const UsageWeekly = Schema.Struct({
  usedPercent: Schema.Finite,
  resetsAtMs: Schema.Finite,
});

const SubscriptionUsage = Schema.Struct({
  observedAtMs: Schema.Finite,
  tier: Schema.String,
  window: UsageWindow,
  weekly: UsageWeekly,
});

/** The subset of MSP `usage/refresh` Cerium reads. */
export const MuseUsageRefresh = Schema.Struct({
  subscriptionActive: Schema.optionalKey(Schema.Boolean),
  tierName: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(SubscriptionUsage),
});
export type MuseUsageRefresh = typeof MuseUsageRefresh.Type;

/** The subset of MSP `usage/read` Cerium reads. */
export const MuseUsageRead = Schema.Struct({
  usage: Schema.optionalKey(SubscriptionUsage),
});
export type MuseUsageRead = typeof MuseUsageRead.Type;

const decodeRefresh = Schema.decodeUnknownEffect(MuseUsageRefresh);
const decodeRead = Schema.decodeUnknownEffect(MuseUsageRead);

const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;

/** A rolling window's length as a label: "5-hour limit", "Daily limit", "Weekly limit". */
export const windowLabel = (minutes: number): string => {
  if (!Number.isFinite(minutes) || minutes <= 0) return "Usage limit";
  if (minutes === WEEK_MINUTES) return "Weekly limit";
  if (minutes === DAY_MINUTES) return "Daily limit";
  if (minutes >= 28 * DAY_MINUTES && minutes <= 31 * DAY_MINUTES) return "Monthly limit";
  if (minutes % DAY_MINUTES === 0) return `${minutes / DAY_MINUTES}-day limit`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${Math.round(minutes)}-minute limit`;
};

const metersOf = (usage: typeof SubscriptionUsage.Type): ReadonlyArray<UsageMeter> => {
  const shortMinutes = Math.round(usage.window.windowDurationMins);
  const shortWindow: UsageMeter = {
    label: windowLabel(shortMinutes),
    usedPercent: Math.max(0, usage.window.usedPercent),
    ...(usage.window.resetsAtMs >= 0 ? { resetsAt: Math.round(usage.window.resetsAtMs) } : {}),
    ...(shortMinutes > 0 ? { windowMinutes: shortMinutes } : {}),
  };
  const weekly: UsageMeter = {
    label: "Weekly limit",
    usedPercent: Math.max(0, usage.weekly.usedPercent),
    ...(usage.weekly.resetsAtMs >= 0 ? { resetsAt: Math.round(usage.weekly.resetsAtMs) } : {}),
    windowMinutes: WEEK_MINUTES,
  };
  return [shortWindow, weekly];
};

const cleanPlan = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

/** Converts MSP `usage/refresh` or `usage/read` data into Cerium's subscription report. */
export const toMuseReport = (result: MuseUsageRefresh): Option.Option<SubscriptionReport> => {
  if (result.usage !== undefined) {
    const plan = cleanPlan(result.tierName) ?? cleanPlan(result.usage.tier);
    return Option.some({
      ...(plan === undefined ? {} : { plan }),
      meters: metersOf(result.usage),
    });
  }
  // Per Muse's MSP contract, `subscriptionActive: true` without `usage` is a subscriber whose mint
  // carried no usage object yet (never treat as no subscription).
  if (result.subscriptionActive === true) {
    const plan = cleanPlan(result.tierName);
    return Option.some({ ...(plan === undefined ? {} : { plan }), meters: [] });
  }
  return Option.none();
};

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "muse", message, cause });

/** Queries an open Muse host for its subscription allowance, falling back to `usage/read`. */
export const hostMuseUsage = Effect.fn("MuseAdapter.hostUsage")(function* (host: MuseHost) {
  const { MspError } = yield* Effect.promise(() => import("@muse-code/sdk"));
  const refreshed = yield* query(host, "usage/refresh").pipe(
    Effect.flatMap((raw) =>
      decodeRefresh(raw).pipe(Effect.mapError(failure("Unexpected `usage/refresh` response from Muse Code"))),
    ),
    Effect.asSome,
    Effect.catch((error) =>
      error instanceof HarnessFailure && error.cause instanceof MspError
        ? Effect.succeedNone
        : Effect.fail(error),
    ),
  );
  if (Option.isSome(refreshed)) return toMuseReport(refreshed.value);

  const read = yield* query(host, "usage/read").pipe(
    Effect.flatMap((raw) =>
      decodeRead(raw).pipe(Effect.mapError(failure("Unexpected `usage/read` response from Muse Code"))),
    ),
  );
  return toMuseReport(read);
});

/** Asks the user's `muse` how much of its subscription allowance is used. */
export const readMuseUsage = Effect.fn("MuseAdapter.usage")(function* (executablePath: string) {
  const host = yield* openHost(executablePath, ["serve", "--no-session-log"], {
    capabilities: { experimentalApi: true, userInputDialogs: false },
  });
  return yield* hostMuseUsage(host);
}, Effect.scoped);
