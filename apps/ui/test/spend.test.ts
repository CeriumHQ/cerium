import { describe, expect, it } from "@effect/vitest";

import {
  cacheShare,
  costGap,
  costLabel,
  rangeEdges,
  tokenLabel,
  tokensOf,
} from "../src/features/settings/spendModel.ts";

const totals = (extra: object = {}) => ({
  inputTokens: 100,
  outputTokens: 20,
  cachedInputTokens: 300,
  turns: 4,
  pricedTurns: 4,
  costUsd: 1.234,
  ...extra,
});

describe("spend ranges", () => {
  const now = new Date(2026, 9, 21, 15, 30).getTime();

  it("cuts today into the hours of the calendar day", () => {
    const edges = rangeEdges("today", now);
    expect(edges).toHaveLength(25);
    expect(new Date(edges[0]!).getHours()).toBe(0);
    expect(new Date(edges[0]!).getDate()).toBe(21);
    expect(new Date(edges.at(-1)!).getDate()).toBe(22);
  });

  it("cuts a week into seven days ending with today, and a month into thirty", () => {
    const week = rangeEdges("week", now);
    expect(week).toHaveLength(8);
    expect(new Date(week[0]!).getDate()).toBe(15);
    expect(new Date(week.at(-2)!).getDate()).toBe(21);
    expect(rangeEdges("month", now)).toHaveLength(31);
  });

  it("always ascends", () => {
    for (const range of ["today", "week", "month"] as const) {
      const edges = rangeEdges(range, now);
      expect(edges.every((edge, index) => index === 0 || edge > edges[index - 1]!)).toBe(true);
    }
  });
});

describe("spend words", () => {
  it("shortens counts without rounding up a unit", () => {
    expect(tokenLabel(0)).toBe("0");
    expect(tokenLabel(840)).toBe("840");
    expect(tokenLabel(1_234)).toBe("1.23K");
    expect(tokenLabel(12_345)).toBe("12.3K");
    expect(tokenLabel(123_456)).toBe("123K");
    expect(tokenLabel(4_560_000)).toBe("4.56M");
  });

  it("counts cached tokens as read, and says how much of the input the cache served", () => {
    expect(tokensOf(totals())).toBe(420);
    expect(cacheShare(totals())).toBe(75);
    expect(cacheShare(totals({ inputTokens: 0, cachedInputTokens: 0 }))).toBeUndefined();
  });

  it("shows a cost only where one was reported, as an estimate", () => {
    expect(costLabel(totals())).toBe("~$1.23");
    expect(costLabel(totals({ pricedTurns: 0, costUsd: 0 }))).toBe("—");
    expect(costLabel(totals({ pricedTurns: 2 }))).toBe("~$1.23+");
    expect(costLabel(totals({ costUsd: 0.004 }))).toBe("<$0.01");
  });

  it("says how much cost is missing", () => {
    expect(costGap(totals())).toBeUndefined();
    expect(costGap(totals({ pricedTurns: 0, costUsd: 0 }))).toBe("No cost was reported.");
    expect(costGap(totals({ pricedTurns: 1 }))).toBe("Cost was reported for 1 of 4 turns.");
  });
});
