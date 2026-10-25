import {
  leftPercent,
  meterLevel,
  paceOf,
  type MeterLevel,
  type ProviderId,
  type ProviderUsage,
  type UsageMeter,
} from "@cerium/protocol";

/** One arc of a usage ring: a limit and what's left of it. */
export interface UsageArc {
  readonly label: string;
  /** What's left of the meter, from 0 to 100. */
  readonly left: number;
  readonly level: MeterLevel;
}

/** What one of the rail's usage rings shows: a harness's limits as concentric arcs. */
export interface UsageRing {
  readonly provider: ProviderId;
  readonly plan?: string;
  /** Outermost first, in the harness's order; at most `MAX_ARCS`. */
  readonly arcs: ReadonlyArray<UsageArc>;
  /** What's left of the limit that will stop the harness first, from 0 to 100. */
  readonly left: number;
  /** Every limit, for the ring's tooltip. */
  readonly meters: ReadonlyArray<UsageMeter>;
}

/** As many arcs as fit between the ring's edge and the harness's mark. */
export const MAX_ARCS = 3;

/**
 * A ring per harness that can run threads and reports a subscription's limits, in the backend's
 * order, with an arc per limit. A spending cap only charges past the plan, so it gets an arc only
 * when the plan has nothing else. Past `MAX_ARCS` limits, the last arc is the tightest of the rest.
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
    const shown =
      candidates.length <= MAX_ARCS
        ? candidates
        : [...candidates.slice(0, MAX_ARCS - 1), tightest(candidates.slice(MAX_ARCS - 1))];
    return [
      {
        provider: each.provider,
        ...(each.plan === undefined ? {} : { plan: each.plan }),
        arcs: shown.map((meter) => ({
          label: meter.label,
          left: leftPercent(meter),
          level: meterLevel(meter, paceOf(meter, now)),
        })),
        left: leftPercent(tightest(candidates)),
        meters: each.meters,
      },
    ];
  });

const tightest = (meters: ReadonlyArray<UsageMeter>): UsageMeter =>
  meters.reduce((tight, meter) => (leftPercent(meter) < leftPercent(tight) ? meter : tight));
