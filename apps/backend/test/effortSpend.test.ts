import { describe, expect, it } from "@effect/vitest";

import { effortSpend } from "../src/effortSpend.ts";

describe("monthly router values", () => {
  it("projects only this month's spend using elapsed calendar time", () => {
    const start = new Date(2026, 9, 1).getTime();
    const end = new Date(2026, 10, 1).getTime();
    const now = start + (end - start) / 2;
    expect(
      effortSpend(
        [
          { at: start - 1, costUsd: 50 },
          { at: start, costUsd: 2 },
        ],
        now,
      ),
    ).toEqual({ monthUsd: 2, totalUsd: 52, projectedMonthUsd: 4, monthEndsAt: end });
  });
  it("resets both values at the exact month boundary and across years", () => {
    const now = new Date(2027, 0, 1).getTime();
    const value = effortSpend([{ at: now - 1, costUsd: 50 }], now);
    expect(value.monthUsd).toBe(0);
    expect(value.projectedMonthUsd).toBe(0);
    expect(value.monthEndsAt).toBe(new Date(2027, 1, 1).getTime());
  });
  it("handles leap February and excludes future events", () => {
    const start = new Date(2028, 1, 1).getTime();
    const end = new Date(2028, 2, 1).getTime();
    const value = effortSpend(
      [
        { at: start, costUsd: 1 },
        { at: end, costUsd: 10 },
      ],
      start + (end - start) / 2,
    );
    expect(value.monthUsd).toBe(1);
    expect(value.projectedMonthUsd).toBe(2);
  });
});
