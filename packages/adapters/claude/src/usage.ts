import { HarnessFailure, type SubscriptionReport } from "@cerium/harness";
import { LenientArray, type MeterLevel, type UsageMeter } from "@cerium/protocol";
import { Effect, Option, Schema } from "effect";

import { inspectClaude } from "./models.ts";

// The plan limits behind Claude Code's `/usage`, read from a session that is never sent a prompt.

const Name = Schema.NullOr(Schema.Struct({ display_name: Schema.String }));

/** One of the server's usage rows, which Claude Code passes on as sent. */
const LimitRow = Schema.Struct({
  /** What the meter is, e.g. `session`, `weekly_all`, `weekly_scoped`. */
  kind: Schema.String,
  group: Schema.String,
  percent: Schema.Finite,
  resets_at: Schema.NullOr(Schema.String),
  severity: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ model: Schema.optionalKey(Name), surface: Schema.optionalKey(Name) })),
  ),
});

/** A named window, as CLIs that predate the rows report it. */
const Window = Schema.optionalKey(
  Schema.NullOr(
    Schema.Struct({ utilization: Schema.NullOr(Schema.Finite), resets_at: Schema.NullOr(Schema.String) }),
  ),
);

/** The subset of the `get_usage` answer Cerium reads. */
export const ClaudeUsage = Schema.Struct({
  subscription_type: Schema.NullOr(Schema.String),
  rate_limits_available: Schema.Boolean,
  rate_limits: Schema.NullOr(
    Schema.Struct({
      limits: Schema.optionalKey(Schema.NullOr(LenientArray(LimitRow))),
      five_hour: Window,
      seven_day: Window,
      seven_day_opus: Window,
      seven_day_sonnet: Window,
      model_scoped: Schema.optionalKey(
        LenientArray(
          Schema.Struct({
            display_name: Schema.String,
            utilization: Schema.NullOr(Schema.Finite),
            resets_at: Schema.NullOr(Schema.String),
          }),
        ),
      ),
      extra_usage: Schema.optionalKey(
        Schema.NullOr(
          Schema.Struct({
            is_enabled: Schema.Boolean,
            /** In the currency's minor units, as `used_credits` is. */
            monthly_limit: Schema.NullOr(Schema.Finite),
            used_credits: Schema.NullOr(Schema.Finite),
            utilization: Schema.NullOr(Schema.Finite),
            currency: Schema.optionalKey(Schema.NullOr(Schema.String)),
            decimal_places: Schema.optionalKey(Schema.NullOr(Schema.Int)),
          }),
        ),
      ),
    }),
  ),
});
export type ClaudeUsage = typeof ClaudeUsage.Type;
const decodeClaudeUsage = Schema.decodeUnknownEffect(ClaudeUsage);

const SESSION_MINUTES = 5 * 60;
const WEEK_MINUTES = 7 * 24 * 60;
const WEEK = "Current week";

const epoch = (iso: string | null): { resetsAt?: number } => {
  const at = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isFinite(at) && at >= 0 ? { resetsAt: Math.round(at) } : {};
};

const levels: ReadonlyArray<string> = ["normal", "warning", "critical"] satisfies ReadonlyArray<MeterLevel>;
const level = (severity: string | undefined): { level?: MeterLevel } =>
  severity !== undefined && levels.includes(severity) ? { level: severity as MeterLevel } : {};

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1).replaceAll("_", " ");

const fromRow = (row: typeof LimitRow.Type): UsageMeter => {
  const scope = row.scope?.model?.display_name ?? row.scope?.surface?.display_name;
  const [label, windowMinutes] =
    row.kind === "session"
      ? ["Current session", SESSION_MINUTES]
      : row.kind === "weekly_all"
        ? [`${WEEK} · All models`, WEEK_MINUTES]
        : row.kind === "weekly_scoped" && scope !== undefined
          ? [`${WEEK} · ${scope}`, WEEK_MINUTES]
          : // A meter this version doesn't know yet still shows, under the server's group.
            [
              scope === undefined ? capitalized(row.group) : `${capitalized(row.group)} · ${scope}`,
              undefined,
            ];
  return {
    label,
    usedPercent: Math.max(0, row.percent),
    ...epoch(row.resets_at),
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...level(row.severity),
  };
};

/**
 * The plan's meters, in the order Claude Code's own `/usage` lists them: `none` without a plan (an
 * API key, Bedrock, Vertex), `unfetched` while Claude Code can't fetch a subscriber's limits.
 */
export const toClaudeReport = (usage: ClaudeUsage): SubscriptionReport | "none" | "unfetched" => {
  if (!usage.rate_limits_available || usage.subscription_type === null) return "none";
  const limits = usage.rate_limits;
  if (limits === null) return "unfetched";

  const windows: ReadonlyArray<UsageMeter> =
    limits.limits != null
      ? limits.limits.map(fromRow)
      : [
          ["Current session", SESSION_MINUTES, limits.five_hour] as const,
          [`${WEEK} · All models`, WEEK_MINUTES, limits.seven_day] as const,
          [`${WEEK} · Opus`, WEEK_MINUTES, limits.seven_day_opus] as const,
          [`${WEEK} · Sonnet`, WEEK_MINUTES, limits.seven_day_sonnet] as const,
          ...(limits.model_scoped ?? []).map(
            (row) => [`${WEEK} · ${row.display_name}`, WEEK_MINUTES, row] as const,
          ),
        ].flatMap(([label, windowMinutes, window]) =>
          window?.utilization == null
            ? []
            : [
                {
                  label,
                  usedPercent: Math.max(0, window.utilization),
                  windowMinutes,
                  ...epoch(window.resets_at),
                },
              ],
        );

  // Extra usage is a monthly spending cap, shown once the plan has one switched on.
  const extra = limits.extra_usage;
  const scale = 10 ** (extra?.decimal_places ?? 2);
  const spend: ReadonlyArray<UsageMeter> =
    extra?.is_enabled &&
    extra.monthly_limit !== null &&
    extra.monthly_limit > 0 &&
    extra.used_credits !== null
      ? [
          {
            label: "Extra usage",
            usedPercent: Math.max(0, extra.utilization ?? (extra.used_credits / extra.monthly_limit) * 100),
            spend: {
              used: extra.used_credits / scale,
              limit: extra.monthly_limit / scale,
              currency: extra.currency ?? "USD",
            },
          },
        ]
      : [];

  return { plan: usage.subscription_type, meters: [...windows, ...spend] };
};

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "claude", message, cause });

/** Asks the user's `claude` how much of its plan's limits are used. */
export const readClaudeUsage = Effect.fn("ClaudeAdapter.usage")(function* (executablePath: string) {
  const answer = yield* inspectClaude(executablePath, undefined, "Could not read Claude's usage", (session) =>
    // Claude Code marks the call experimental; a version without it fails here, and says so.
    session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
  );
  const usage = yield* decodeClaudeUsage(answer).pipe(Effect.mapError(failure("Unexpected usage answer")));
  const report = toClaudeReport(usage);
  if (report === "unfetched") {
    return yield* new HarnessFailure({
      provider: "claude",
      message: "Claude Code couldn't fetch your plan's usage. Try again in a moment.",
      cause: usage,
    });
  }
  return report === "none" ? Option.none<SubscriptionReport>() : Option.some(report);
});
