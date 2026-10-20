import { describe, expect, it } from "@effect/vitest";

import {
  leftLabel,
  leftPercent,
  meterLevel,
  paceOf,
  planName,
  resetLabel,
  runsOutLabel,
  spendLabel,
} from "../src/features/settings/usageModel.ts";

const meter = (usedPercent: number, extra: object = {}) => ({ label: "Weekly", usedPercent, ...extra });

describe("usage meters", () => {
  it("says what's left, and never rounds a meter that isn't spent to empty", () => {
    expect(leftLabel(meter(8))).toBe("92% left");
    expect(leftLabel(meter(99.6))).toBe("Under 1% left");
    expect(leftLabel(meter(100))).toBe("Limit reached");
    expect(leftLabel(meter(130))).toBe("Limit reached");
    expect(leftPercent(meter(130))).toBe(0);
  });

  it("follows the harness's grading, except past the limit", () => {
    expect(meterLevel(meter(95, { level: "normal" }))).toBe("normal");
    expect(meterLevel(meter(20, { level: "warning" }))).toBe("warning");
    expect(meterLevel(meter(100, { level: "normal" }))).toBe("critical");
    expect([10, 80, 92].map((used) => meterLevel(meter(used)))).toEqual(["normal", "warning", "critical"]);
  });

  it("words a spending meter in its currency", () => {
    const extra = meter(25, { spend: { used: 12.5, limit: 50, currency: "USD" } });
    expect(leftLabel(extra)).toBe("$37.50 left");
    expect(spendLabel(extra)).toBe("$12.50 of $50.00 spent");
    expect(spendLabel(meter(25))).toBeUndefined();
  });

  it("says when a meter resets, closer ones counted down", () => {
    const now = new Date(2026, 9, 20, 9, 0).getTime();
    const minutes = (count: number) => now + count * 60_000;
    expect(resetLabel(now - 1, now)).toBe("Resetting now");
    expect(resetLabel(now + 20_000, now)).toBe("Resets in under a minute");
    expect(resetLabel(minutes(46.5), now)).toBe("Resets in 47 min");
    expect(resetLabel(minutes(180), now)).toBe("Resets in 3 hr");
    expect(resetLabel(minutes(192), now)).toBe("Resets in 3 hr 12 min");
    expect(resetLabel(new Date(2026, 9, 22, 15, 59).getTime(), now)).toMatch(/^Resets Thu 3:59\sPM$/u);
    expect(resetLabel(new Date(2026, 10, 17).getTime(), now)).toBe("Resets Nov 17");
    expect(resetLabel(new Date(2027, 0, 3).getTime(), now)).toBe("Resets Jan 3, 2027");
  });

  it("paces a window: how much of it has gone, and when use outruns it", () => {
    const now = 1_000_000_000;
    const hour = 3_600_000;
    // A 5-hour window with 2 hours left: 60% of it gone.
    const window = (usedPercent: number) =>
      meter(usedPercent, { resetsAt: now + 2 * hour, windowMinutes: 300 });
    expect(paceOf(window(50), now)).toEqual({ elapsed: 60, fast: false });
    const fast = paceOf(window(80), now);
    expect(fast?.fast).toBe(true);
    // 80% in 3 hours: the last 20% goes in 45 minutes, before the reset.
    expect(fast?.runsOutAt).toBe(now + 0.75 * hour);
    expect(meterLevel(window(80), fast)).toBe("warning");
    expect(meterLevel(window(50), paceOf(window(50), now))).toBe("normal");
    expect(paceOf(meter(50), now)).toBeUndefined();
    expect(paceOf(window(100), now)).toBeUndefined();
    expect(runsOutLabel(now + 0.75 * hour, now)).toBe("Runs out in ~45 min");
    expect(runsOutLabel(now + 50 * hour, now)).toBe("Runs out in ~2 days");
  });

  it("names plans", () => {
    expect(["max", "plus", "edu_plus", "prolite", "enterprise_cbp_usage_based"].map(planName)).toEqual([
      "Max",
      "Plus",
      "Edu Plus",
      "Pro Lite",
      "Enterprise",
    ]);
  });
});
