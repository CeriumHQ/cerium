import { leftPercent, type ProviderId, type ProviderUsage, type UsageMeter } from "@cerium/protocol";

/** What one of the rail's usage rings shows: a harness's tightest limit, and every limit for its tooltip. */
export interface UsageRing {
  readonly provider: ProviderId;
  readonly plan?: string;
  /** The limit that will stop the harness first, which the ring draws. */
  readonly label: string;
  /** What's left of that limit, from 0 to 100. */
  readonly left: number;
  /** Every limit, for the ring's tooltip. */
  readonly meters: ReadonlyArray<UsageMeter>;
}

/**
 * A ring per harness that can run threads and reports a subscription's limits, in the backend's
 * order, showing the limit with the least left. A spending cap only charges past the plan, so it
 * counts only when the plan has nothing else.
 */
export const usageRings = (
  usage: ReadonlyArray<ProviderUsage>,
  ready: ReadonlySet<ProviderId>,
): ReadonlyArray<UsageRing> =>
  usage.flatMap((each) => {
    if (each._tag !== "Subscribed" || !ready.has(each.provider) || each.meters.length === 0) return [];
    const limits = each.meters.filter((meter) => meter.spend === undefined);
    const binding = tightest(limits.length > 0 ? limits : each.meters);
    return [
      {
        provider: each.provider,
        ...(each.plan === undefined ? {} : { plan: each.plan }),
        label: binding.label,
        left: leftPercent(binding),
        meters: each.meters,
      },
    ];
  });

const tightest = (meters: ReadonlyArray<UsageMeter>): UsageMeter =>
  meters.reduce((tight, meter) => (leftPercent(meter) < leftPercent(tight) ? meter : tight));
