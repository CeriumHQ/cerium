import type { SpendTotals } from "@cerium/protocol";

// How Settings → Cost cuts time and words what agents used.

export type SpendRange = "today" | "week" | "month";

export const spendRanges: ReadonlyArray<{ readonly id: SpendRange; readonly label: string }> = [
  { id: "today", label: "Today" },
  { id: "week", label: "7 days" },
  { id: "month", label: "30 days" },
];

/**
 * Where each range is cut, on the calendar of the window asking: hours of today, then days of the
 * last week (this one included) or of the last thirty. Always ascending, which a day the clocks
 * change on would not be if its hours were counted out.
 */
export const rangeEdges = (range: SpendRange, now: number): Array<number> => {
  const today = new Date(now);
  const at = (day: number, hour: number) =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() + day, hour).getTime();
  const edges =
    range === "today"
      ? Array.from({ length: 25 }, (_, hour) => at(0, hour))
      : Array.from({ length: range === "week" ? 8 : 31 }, (_, index) =>
          at(index - (range === "week" ? 6 : 29), 0),
        );
  return edges.filter((edge, index) => index === 0 || edge > edges[index - 1]!);
};

/** A bucket's name for its tooltip: "3 PM" for an hour of today, "Tue, Nov 17" for a day. */
export const bucketLabel = (range: SpendRange, start: number): string =>
  new Date(start).toLocaleString(
    [],
    range === "today" ? { hour: "numeric" } : { weekday: "short", month: "short", day: "numeric" },
  );

/** Everything a group of turns read and wrote, the cache's share included. */
export const tokensOf = (totals: SpendTotals): number =>
  totals.inputTokens + totals.cachedInputTokens + totals.outputTokens;

/** A count of tokens as people say it: "840", "12.3K", "4.6M". */
export const tokenLabel = (count: number): string => {
  if (count < 1_000) return String(count);
  const [scaled, suffix] = count < 1_000_000 ? [count / 1_000, "K"] : [count / 1_000_000, "M"];
  // Three digits at most: "12.3K" but "123K", and never "1000K".
  const text = scaled < 10 ? scaled.toFixed(2) : scaled < 100 ? scaled.toFixed(1) : scaled.toFixed(0);
  return `${Number(text)}${suffix}`;
};

/** The cache's share of what was read, in whole percent; none when nothing was read. */
export const cacheShare = (totals: SpendTotals): number | undefined => {
  const read = totals.inputTokens + totals.cachedInputTokens;
  return read === 0 ? undefined : Math.round((totals.cachedInputTokens / read) * 100);
};

/** Dollars to the cent, as an estimate; a part of a cent that was spent isn't shown as nothing. */
const dollars = (amount: number): string =>
  amount > 0 && amount < 0.01
    ? "<$0.01"
    : `~${new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(amount)}`;

/**
 * A cost to show. Harnesses price their turns with rates of their own and Cerium adds nothing, so the
 * figure is an estimate (`~`), and a plus says some turns reported none. None where no turn did.
 */
export const costLabel = (totals: SpendTotals): string => {
  if (totals.pricedTurns === 0) return "—";
  return `${dollars(totals.costUsd)}${totals.pricedTurns < totals.turns ? "+" : ""}`;
};

/** Says how much of the cost is missing, for a tooltip; none when all of it was reported. */
export const costGap = (totals: SpendTotals): string | undefined => {
  const missing = totals.turns - totals.pricedTurns;
  if (missing === 0) return undefined;
  return totals.pricedTurns === 0
    ? "No cost was reported."
    : `Cost was reported for ${totals.pricedTurns} of ${totals.turns} turns.`;
};
