import {
  leftPercent,
  meterLevel,
  paceOf,
  type MeterLevel,
  type ProviderId,
  type ProviderUsage,
  type UsageMeter,
} from "@cerium/protocol";

/** What one of the rail's usage rings shows: a harness's tightest limit. */
export interface UsageRing {
  readonly provider: ProviderId;
  readonly plan?: string;
  /** What's left of the meter closest to its limit, from 0 to 100. */
  readonly left: number;
  readonly level: MeterLevel;
  /** Every limit, for the ring's tooltip. */
  readonly meters: ReadonlyArray<UsageMeter>;
}

/**
 * A ring per harness that can run threads and reports a subscription's limits, in the backend's
 * order. Each fills with what's left of the limit that will stop it first: a spending cap only
 * charges past the plan, so it counts only when the plan has nothing else.
 */
export const usageRings = (
  usage: ReadonlyArray<ProviderUsage>,
  ready: ReadonlySet<ProviderId>,
  now: number,
): ReadonlyArray<UsageRing> =>
  usage.flatMap((each) => {
    if (each._tag !== "Subscribed" || !ready.has(each.provider) || each.meters.length === 0) return [];
    const limits = each.meters.filter((meter) => meter.spend === undefined);
    const candidates = limits.length > 0 ? limits : each.meters;
    const tightest = candidates.reduce((tight, meter) =>
      leftPercent(meter) < leftPercent(tight) ? meter : tight,
    );
    // The worst level of any limit, so one running fast colours the ring even when it isn't the tightest.
    const level = candidates
      .map((meter) => meterLevel(meter, paceOf(meter, now)))
      .reduce((worst, next) => (rank[next] > rank[worst] ? next : worst), "normal");
    return [
      {
        provider: each.provider,
        ...(each.plan === undefined ? {} : { plan: each.plan }),
        left: leftPercent(tightest),
        level,
        meters: each.meters,
      },
    ];
  });

const rank: Record<MeterLevel, number> = { normal: 0, warning: 1, critical: 2 };
