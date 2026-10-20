import { UsageMeter } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { ClaudeUsage, toClaudeReport } from "../src/usage.ts";

const decode = Schema.decodeUnknownSync(ClaudeUsage);

// Trimmed from a live `get_usage` answer on a Max plan.
const live = {
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 8, resets_at: "2026-10-20T05:39:59.515274+00:00" },
    seven_day: { utilization: 11, resets_at: "2026-10-20T22:59:59.515297+00:00" },
    seven_day_opus: null,
    extra_usage: {
      is_enabled: false,
      monthly_limit: null,
      used_credits: 0,
      utilization: null,
      currency: "USD",
      decimal_places: 2,
    },
    limits: [
      {
        kind: "session",
        group: "session",
        percent: 8,
        resets_at: "2026-10-20T05:39:59.515274+00:00",
        severity: "normal",
        is_active: false,
        scope: null,
      },
      {
        kind: "weekly_all",
        group: "weekly",
        percent: 11,
        resets_at: "2026-10-20T22:59:59.515297+00:00",
        severity: "normal",
        is_active: true,
        scope: null,
      },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 0,
        resets_at: "2026-10-20T23:00:00+00:00",
        severity: "warning",
        is_active: false,
        scope: { model: { display_name: "Fable", id: null }, surface: null },
      },
    ],
    some_future_window: { utilization: 42 },
  },
};

describe("toClaudeReport", () => {
  it("lists the server's rows in order, named and graded", () => {
    const report = toClaudeReport(decode(live));
    expect(report).toEqual({
      plan: "max",
      meters: [
        {
          label: "Current session",
          usedPercent: 8,
          resetsAt: Date.UTC(2026, 9, 20, 5, 39, 59, 515),
          windowMinutes: 300,
          level: "normal",
        },
        {
          label: "Current week · All models",
          usedPercent: 11,
          resetsAt: Date.UTC(2026, 9, 20, 22, 59, 59, 515),
          windowMinutes: 10080,
          level: "normal",
        },
        {
          label: "Current week · Fable",
          usedPercent: 0,
          resetsAt: Date.UTC(2026, 9, 20, 23),
          windowMinutes: 10080,
          level: "warning",
        },
      ],
    });
    const meters = typeof report === "object" ? report.meters : [];
    expect(meters.every(Schema.is(UsageMeter))).toBe(true);
  });

  it("names a row of a kind it doesn't know by its group", () => {
    const usage = decode({
      ...live,
      rate_limits: {
        limits: [
          {
            kind: "monthly_surface",
            group: "monthly",
            percent: 30,
            resets_at: null,
            scope: { surface: { display_name: "Claude Design" } },
          },
          { kind: "broken" },
        ],
      },
    });
    expect(toClaudeReport(usage)).toEqual({
      plan: "max",
      meters: [{ label: "Monthly · Claude Design", usedPercent: 30 }],
    });
  });

  it("reads the named windows from a Claude Code that predates the rows", () => {
    const { limits: _, ...windows } = live.rate_limits;
    const report = toClaudeReport(decode({ ...live, rate_limits: windows }));
    expect(typeof report === "object" && report.meters.map((meter) => meter.label)).toEqual([
      "Current session",
      "Current week · All models",
    ]);
  });

  it("adds extra usage once it has a monthly cap, in dollars", () => {
    const usage = decode({
      ...live,
      rate_limits: {
        limits: [],
        extra_usage: {
          is_enabled: true,
          monthly_limit: 5000,
          used_credits: 1250,
          utilization: null,
          currency: "USD",
        },
      },
    });
    expect(toClaudeReport(usage)).toEqual({
      plan: "max",
      meters: [{ label: "Extra usage", usedPercent: 25, spend: { used: 12.5, limit: 50, currency: "USD" } }],
    });
  });

  it("reports nothing without a plan, and says when a subscriber's limits couldn't be fetched", () => {
    expect(
      toClaudeReport(decode({ subscription_type: null, rate_limits_available: false, rate_limits: null })),
    ).toBe("none");
    expect(toClaudeReport(decode({ ...live, rate_limits: null }))).toBe("unfetched");
  });
});
