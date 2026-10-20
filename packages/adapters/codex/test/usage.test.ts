import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import { CodexRateLimits, toCodexReport, windowLabel } from "../src/usage.ts";

const decode = Schema.decodeUnknownSync(CodexRateLimits);

const snapshot = (overrides: Record<string, unknown>) => ({
  limitId: "codex",
  limitName: null,
  normalModelSlug: null,
  primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1794865638 },
  secondary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: 1795000000 },
  credits: { hasCredits: false, unlimited: false, balance: null },
  individualLimit: null,
  spendControlReached: false,
  planType: "plus",
  rateLimitReachedType: null,
  ...overrides,
});

describe("toCodexReport", () => {
  it("lists each bucket's windows, the main bucket first", () => {
    const spark = snapshot({
      limitId: "codex_spark",
      limitName: "GPT-5.3-Codex-Spark",
      primary: { usedPercent: 120, windowDurationMins: 300, resetsAt: null },
      secondary: null,
    });
    const limits = decode({
      ordinaryUsageAllowed: true,
      rateLimits: snapshot({}),
      rateLimitsByLimitId: { codex_spark: spark, codex: snapshot({}) },
      accountId: "not read",
    });
    expect(toCodexReport(limits)).toEqual(
      Option.some({
        plan: "plus",
        meters: [
          { label: "5-hour limit", usedPercent: 7, resetsAt: 1794865638000, windowMinutes: 300 },
          { label: "Weekly limit", usedPercent: 31, resetsAt: 1795000000000, windowMinutes: 10080 },
          { label: "5-hour limit · GPT-5.3-Codex-Spark", usedPercent: 120, windowMinutes: 300 },
        ],
      }),
    );
  });

  it("falls back to the single bucket from servers that report only one", () => {
    const report = toCodexReport(
      decode({ rateLimits: snapshot({ secondary: null }), rateLimitsByLimitId: null }),
    );
    expect(Option.map(report, ({ meters }) => meters.map((meter) => meter.label))).toEqual(
      Option.some(["5-hour limit"]),
    );
  });

  it("reports nothing for a free plan or an API key", () => {
    // The free plan's answer, as a live account gave it.
    const free = snapshot({
      primary: { usedPercent: 7, windowDurationMins: 43200, resetsAt: 1794865638 },
      secondary: null,
      planType: "free",
    });
    expect(toCodexReport(decode({ rateLimits: free, rateLimitsByLimitId: { codex: free } }))).toEqual(
      Option.none(),
    );
    expect(
      toCodexReport(decode({ rateLimits: snapshot({ planType: null }), rateLimitsByLimitId: null })),
    ).toEqual(Option.none());
  });
});

describe("windowLabel", () => {
  it("names windows as Codex does", () => {
    expect([300, 1440, 10080, 43200, 4320, 90, null].map(windowLabel)).toEqual([
      "5-hour limit",
      "Daily limit",
      "Weekly limit",
      "Monthly limit",
      "3-day limit",
      "90-minute limit",
      "Usage limit",
    ]);
  });
});
