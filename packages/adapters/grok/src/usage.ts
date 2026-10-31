import { withAcpAgent } from "@cerium/adapter-acp";
import { HarnessFailure, type SubscriptionReport } from "@cerium/harness";
import type { UsageMeter } from "@cerium/protocol";
import { Effect, Option } from "effect";

import { grokExtension, grokHarness } from "./harness.ts";

// The plan's credits, as Grok's own `/usage` shows them: `_x.ai/billing` answers with the share of the
// included credits used this period and when the period ends. API-key sign-ins have no plan.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const cents = (value: unknown) =>
  isRecord(value) && typeof value["val"] === "number" ? value["val"] : undefined;

/** `USAGE_PERIOD_TYPE_WEEKLY` as "Weekly". */
const periodLabel = (type: unknown) => {
  const word = typeof type === "string" ? /USAGE_PERIOD_TYPE_([A-Z]+)/.exec(type)?.[1] : undefined;
  return word === undefined ? "Credits" : `${word.charAt(0)}${word.slice(1).toLowerCase()}`;
};

/** An `_x.ai/billing` answer as Cerium's meters; none when it carries no allowance. */
export const billingReport = (answer: unknown): Option.Option<SubscriptionReport> => {
  if (!isRecord(answer)) return Option.none();
  const config = isRecord(answer["config"]) ? answer["config"] : undefined;
  if (config === undefined) return Option.none();
  const period = isRecord(config["currentPeriod"]) ? config["currentPeriod"] : undefined;
  const ends = [period?.["end"], config["billingPeriodEnd"]].find((value) => typeof value === "string");
  const end = typeof ends === "string" ? Date.parse(ends) : Number.NaN;
  const limit = cents(config["monthlyLimit"]);
  const used = cents(config["used"]);
  const percent =
    typeof config["creditUsagePercent"] === "number"
      ? config["creditUsagePercent"]
      : limit !== undefined && limit > 0 && used !== undefined
        ? (used / limit) * 100
        : undefined;
  if (percent === undefined) return Option.none();
  const meter: UsageMeter = {
    label: period === undefined ? "Monthly" : periodLabel(period["type"]),
    usedPercent: Math.max(0, percent),
    ...(Number.isFinite(end) ? { resetsAt: end } : {}),
  };
  const tier = typeof answer["subscriptionTier"] === "string" ? answer["subscriptionTier"] : undefined;
  return Option.some({ ...(tier ? { plan: tier } : {}), meters: [meter] });
};

/** Reads the plan's meters through a signed-in agent, outside any session. */
export const readGrokUsage = (executablePath: string) =>
  withAcpAgent(grokHarness, executablePath, "probe", (agent) =>
    agent.signedIn
      ? grokExtension(agent.connection, "billing", {}).pipe(
          Effect.map(billingReport),
          Effect.mapError(
            (cause) =>
              new HarnessFailure({
                provider: "grok",
                message: `Grok Build couldn't read its usage: ${cause.message}`,
                cause,
              }),
          ),
        )
      : Effect.succeed(Option.none<SubscriptionReport>()),
  );
