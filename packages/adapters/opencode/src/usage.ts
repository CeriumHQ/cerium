import { HarnessFailure, type SubscriptionReport } from "@cerium/harness";
import type { UsageMeter } from "@cerium/protocol";
import { Effect, Option, Schema } from "effect";

import type { OpenCodeHost } from "./host.ts";

// OpenCode Go allowances and Console spending budgets, from the local `opencode serve` route
// `GET /api/experimental/usage/limits` (OpenCode 2.3+). Workspace IDs and URLs are never decoded.

const GoMeter = Schema.Struct({
  percent: Schema.Finite,
  limited: Schema.Boolean,
  resetsAt: Schema.Finite,
});

const BudgetModel = Schema.Struct({
  name: Schema.String,
});

const Budget = Schema.Struct({
  id: Schema.String,
  limit: Schema.Finite,
  spent: Schema.Finite,
  coverage: Schema.String,
  models: Schema.Array(BudgetModel),
  vendors: Schema.Array(Schema.String),
  resetsAt: Schema.Finite,
});

/** The subset of `GET /api/experimental/usage/limits` Cerium reads. */
export const OpenCodeUsageLimits = Schema.Struct({
  data: Schema.NullOr(
    Schema.Struct({
      go: Schema.optionalKey(
        Schema.Struct({
          rolling: GoMeter,
          weekly: GoMeter,
          monthly: GoMeter,
        }),
      ),
      budgets: Schema.Array(Budget),
    }),
  ),
});
export type OpenCodeUsageLimits = typeof OpenCodeUsageLimits.Type;

const decodeUsageLimits = Schema.decodeUnknownEffect(OpenCodeUsageLimits);

const FIVE_HOURS = 5 * 60;
const WEEK = 7 * 24 * 60;

const goMeter = (label: string, meter: typeof GoMeter.Type, windowMinutes?: number): UsageMeter => ({
  label,
  usedPercent: Math.max(0, meter.percent),
  ...(meter.resetsAt >= 0 ? { resetsAt: Math.round(meter.resetsAt) } : {}),
  ...(windowMinutes === undefined ? {} : { windowMinutes }),
  ...(meter.limited ? { level: "critical" as const } : {}),
});

const budgetLabel = (budget: typeof Budget.Type): string => {
  if (budget.coverage === "all") return "Console budget";
  const names = budget.models.map((model) => model.name.trim()).filter((name) => name.length > 0);
  const scope =
    names.length > 0
      ? names.slice(0, 2).join(", ") + (names.length > 2 ? ` +${names.length - 2}` : "")
      : budget.vendors
          .filter((vendor) => vendor.trim().length > 0)
          .slice(0, 2)
          .join(", ");
  return scope ? `Budget · ${scope}` : "Console budget";
};

/** Converts OpenCode's usage limits payload into Cerium's subscription report. */
export const toOpenCodeReport = (payload: OpenCodeUsageLimits): Option.Option<SubscriptionReport> => {
  const data = payload.data;
  if (data === null) return Option.none();

  const goMeters: ReadonlyArray<UsageMeter> =
    data.go === undefined
      ? []
      : [
          goMeter("5-hour limit", data.go.rolling, FIVE_HOURS),
          goMeter("Weekly limit", data.go.weekly, WEEK),
          goMeter("Monthly limit", data.go.monthly),
        ];

  const budgetMeters: ReadonlyArray<UsageMeter> = data.budgets.flatMap(
    (budget): ReadonlyArray<UsageMeter> => {
      if (budget.limit <= 0) return [];
      const spent = Math.max(0, budget.spent);
      return [
        {
          label: budgetLabel(budget),
          usedPercent: Math.max(0, (spent / budget.limit) * 100),
          ...(budget.resetsAt >= 0 ? { resetsAt: Math.round(budget.resetsAt) } : {}),
          spend: { used: spent, limit: budget.limit, currency: "USD" },
        },
      ];
    },
  );

  const meters = [...goMeters, ...budgetMeters];
  if (meters.length === 0) return Option.none();
  return Option.some({
    ...(data.go === undefined ? {} : { plan: "go" }),
    meters,
  });
};

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "opencode", message, cause });

/** Queries the running OpenCode server for Go subscription limits and Console budgets. */
export const readOpenCodeUsage = Effect.fn("OpenCodeAdapter.usage")(function* (host: OpenCodeHost) {
  const response = yield* Effect.tryPromise({
    try: (signal) => host.get("/api/experimental/usage/limits", signal),
    catch: failure("Could not reach OpenCode's usage endpoint"),
  });
  // OpenCode 2.0–2.2 predates `/api/experimental/usage/limits`.
  if (response.status === 404 || response.status === 405) return Option.none<SubscriptionReport>();
  if (!response.ok) {
    return yield* new HarnessFailure({
      provider: "opencode",
      message: `OpenCode could not read its usage limits (HTTP ${response.status}).`,
      cause: null,
    });
  }
  const body = yield* Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: failure("OpenCode returned malformed usage data"),
  });
  const parsed = yield* decodeUsageLimits(body).pipe(
    Effect.mapError(failure("Unexpected OpenCode usage response")),
  );
  return toOpenCodeReport(parsed);
});
