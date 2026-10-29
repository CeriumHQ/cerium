import { leftPercent, type ProviderId, type ProviderUsage, type UsageMeter } from "@cerium/protocol";

import { isListed, isPutOff, needsYou, type ThreadSummary } from "../features/threads/model.ts";

/** A count on a rail place, in the attention colour while any of them waits on the user. */
export interface RailBadge {
  readonly count: number;
  /** How many of them wait on the user. */
  readonly waiting: number;
}

/**
 * The rail's badges. Home counts the inbox's work threads that are unread or wait on the user; Chat,
 * whose threads keep no read state, counts the chats waiting for an approval.
 */
export const railBadges = (
  threads: ReadonlyArray<ThreadSummary>,
  now: number,
): { readonly home?: RailBadge; readonly chat?: RailBadge } => {
  const live = threads.filter((thread) => isListed(thread) && !isPutOff(thread, now));
  const work = live.filter((thread) => thread.mode === "work");
  const home = work.filter((thread) => thread.unread || needsYou(thread));
  const chat = live.filter((thread) => thread.mode === "chat" && thread.status === "awaitingApproval");
  return {
    ...(home.length > 0 ? { home: { count: home.length, waiting: home.filter(needsYou).length } } : {}),
    ...(chat.length > 0 ? { chat: { count: chat.length, waiting: chat.length } } : {}),
  };
};

/** A badge's count as it fits the rail: past nine, "9+". */
export const badgeLabel = (count: number): string => (count > 9 ? "9+" : String(count));

/** What a badge counts, for its place's tooltip: "2 unread · 1 needs you". */
export const badgeNote = ({ count, waiting }: RailBadge): string =>
  [
    ...(count > waiting ? [`${count - waiting} unread`] : []),
    ...(waiting > 0 ? [`${waiting} ${waiting === 1 ? "needs" : "need"} you`] : []),
  ].join(" · ");

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
