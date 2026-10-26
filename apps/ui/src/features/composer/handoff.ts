import type { ModelInfo, ProviderId, ProviderUsage, UsageMeter } from "@cerium/protocol";

import { defaultModel } from "./models.ts";

// When an open thread's lead is running low on its harness's limits, and where it could carry on.

/** What's left of a meter, in percent, at which the lead is offered another harness. */
const LOW_LEFT = 5;

/** A meter of the lead's harness that runs low: amber with 5% or less left, red once spent. */
export interface LowMeter {
  readonly meter: UsageMeter;
  readonly level: "warning" | "critical";
}

/**
 * The most nearly spent of `provider`'s meters once it has 5% or less left; none while each has
 * more. Only what's left counts: a fast pace alone doesn't offer another harness. Any harness that
 * reports its limits is read alike.
 */
export const runningLow = (
  usage: ReadonlyArray<ProviderUsage>,
  provider: ProviderId,
): LowMeter | undefined => {
  const low = usage
    .flatMap((each) => (each._tag === "Subscribed" && each.provider === provider ? each.meters : []))
    .filter((meter) => 100 - meter.usedPercent <= LOW_LEFT)
    .toSorted((a, b) => b.usedPercent - a.usedPercent)[0];
  if (low === undefined) return undefined;
  return { meter: low, level: low.usedPercent >= 100 ? "critical" : "warning" };
};

/**
 * Where a lead running low on `from` could carry on: the default model of the first other harness
 * that can run and isn't running low itself (one whose usage isn't read counts as having room).
 */
export const handoffTarget = (
  models: ReadonlyArray<ModelInfo>,
  available: ReadonlySet<ProviderId>,
  usage: ReadonlyArray<ProviderUsage>,
  from: ProviderId,
): ModelInfo | undefined => {
  for (const provider of new Set(models.map((model) => model.provider))) {
    if (provider === from || !available.has(provider) || runningLow(usage, provider) !== undefined) continue;
    const model = defaultModel(models, provider);
    if (model !== undefined) return model;
  }
  return undefined;
};
