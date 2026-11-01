import type { AcpConnection } from "@cerium/adapter-acp";
import { HarnessFailure, type SubscriptionReport } from "@cerium/harness";
import type { UsageMeter } from "@cerium/protocol";
import { Effect, Option, Schema } from "effect";

// A Grok subscription's usage, as Grok's own `/usage` reads it (`x.ai/billing`): the share of the
// plan's credits the current period has used, and when the period ends.

const nullable = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema));

const Billing = Schema.Struct({
  config: nullable(
    Schema.Struct({
      creditUsagePercent: nullable(Schema.Finite),
      currentPeriod: nullable(
        Schema.Struct({
          type: nullable(Schema.String),
          start: nullable(Schema.String),
          end: nullable(Schema.String),
        }),
      ),
    }),
  ),
  subscription_tier: nullable(Schema.String),
});
const decodeBilling = Schema.decodeUnknownEffect(Billing);

const PERIODS: Readonly<Record<string, string>> = {
  USAGE_PERIOD_TYPE_DAILY: "Daily",
  USAGE_PERIOD_TYPE_WEEKLY: "Weekly",
  USAGE_PERIOD_TYPE_MONTHLY: "Monthly",
};

const timeOf = (value: string | null | undefined) => {
  const at = value === undefined || value === null ? Number.NaN : Date.parse(value);
  return Number.isNaN(at) ? undefined : at;
};

/** The plan and its meter, or `None` when the account has no plan with limits. */
export const reportOf = (billing: typeof Billing.Type): Option.Option<SubscriptionReport> => {
  const used = billing.config?.creditUsagePercent;
  if (used === undefined || used === null) return Option.none();
  const period = billing.config?.currentPeriod ?? undefined;
  const start = timeOf(period?.start);
  const end = timeOf(period?.end);
  const minutes = start === undefined || end === undefined ? undefined : Math.round((end - start) / 60_000);
  const meter: UsageMeter = {
    label: PERIODS[period?.type ?? ""] ?? "Usage",
    usedPercent: Math.max(0, used),
    ...(end === undefined ? {} : { resetsAt: end }),
    ...(minutes === undefined || minutes <= 0 ? {} : { windowMinutes: minutes }),
  };
  const plan = billing.subscription_tier?.trim();
  return Option.some({ ...(plan ? { plan } : {}), meters: [meter] });
};

export const readGrokUsage = (connection: AcpConnection) =>
  connection.request("_x.ai/billing", {}).pipe(
    Effect.flatMap(decodeBilling),
    Effect.map(reportOf),
    Effect.mapError(
      (cause) => new HarnessFailure({ provider: "grok", message: "Could not read the Grok usage", cause }),
    ),
  );
