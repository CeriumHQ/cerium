import { UsageMeter } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";
import { Option, Schema } from "effect";

import { MuseUsageRead, MuseUsageRefresh, toMuseReport, windowLabel } from "../src/usage.ts";

const decodeRefresh = Schema.decodeUnknownSync(MuseUsageRefresh);
const decodeRead = Schema.decodeUnknownSync(MuseUsageRead);

describe("toMuseReport", () => {
  it("reports the short window and weekly allowance with the tier display name", () => {
    const report = toMuseReport(
      decodeRefresh({
        subscriptionActive: true,
        tierName: "Pro",
        usage: {
          observedAtMs: 1_795_000_000_000,
          tier: "tier_pro",
          window: {
            usedPercent: 24,
            resetsAtMs: 1_795_010_000_000,
            windowDurationMins: 300,
          },
          weekly: {
            usedPercent: 61,
            resetsAtMs: 1_795_500_000_000,
          },
        },
      }),
    );
    expect(report).toEqual(
      Option.some({
        plan: "Pro",
        meters: [
          {
            label: "5-hour limit",
            usedPercent: 24,
            resetsAt: 1_795_010_000_000,
            windowMinutes: 300,
          },
          {
            label: "Weekly limit",
            usedPercent: 61,
            resetsAt: 1_795_500_000_000,
            windowMinutes: 10_080,
          },
        ],
      }),
    );
    expect(Option.isSome(report) && report.value.meters.every(Schema.is(UsageMeter))).toBe(true);
  });

  it("falls back to usage.tier when reading from older usage/read responses", () => {
    const report = toMuseReport(
      decodeRead({
        usage: {
          observedAtMs: 1_795_000_000_000,
          tier: "max",
          window: {
            usedPercent: 112,
            resetsAtMs: 1_795_010_000_000,
            windowDurationMins: 300,
          },
          weekly: {
            usedPercent: 5,
            resetsAtMs: 1_795_500_000_000,
          },
        },
      }),
    );
    expect(Option.isSome(report) ? report.value.plan : undefined).toBe("max");
    expect(Option.isSome(report) ? report.value.meters[0]?.usedPercent : undefined).toBe(112);
  });

  it("distinguishes an active subscriber with no usage yet from a non-subscriber", () => {
    expect(toMuseReport(decodeRefresh({ subscriptionActive: true, tierName: "Pro" }))).toEqual(
      Option.some({ plan: "Pro", meters: [] }),
    );
    expect(toMuseReport(decodeRefresh({ subscriptionActive: false }))).toEqual(Option.none());
    expect(toMuseReport(decodeRead({}))).toEqual(Option.none());
  });
});

describe("windowLabel", () => {
  it("formats window durations into human labels", () => {
    expect([300, 1440, 10_080, 43_200, 90, 0].map(windowLabel)).toEqual([
      "5-hour limit",
      "Daily limit",
      "Weekly limit",
      "Monthly limit",
      "90-minute limit",
      "Usage limit",
    ]);
  });
});
