import { UsageMeter } from "@cerium/protocol";
import { Option, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { CopilotQuota, toCopilotReport } from "../src/usage.ts";

const decode = Schema.decodeUnknownSync(CopilotQuota);

describe("toCopilotReport", () => {
  it("reports metered buckets in priority order and skips unlimited ones", () => {
    const report = toCopilotReport(
      decode({
        quotaSnapshots: {
          chat: {
            isUnlimitedEntitlement: true,
            entitlementRequests: -1,
            usedRequests: 0,
            remainingPercentage: 100,
          },
          completions: {
            isUnlimitedEntitlement: true,
            entitlementRequests: -1,
            usedRequests: 0,
            remainingPercentage: 100,
          },
          premium_interactions: {
            isUnlimitedEntitlement: false,
            entitlementRequests: 300,
            usedRequests: 90,
            remainingPercentage: 70,
            overage: 0,
            overageAllowedWithExhaustedQuota: true,
            usageAllowedWithExhaustedQuota: true,
            resetDate: "2026-12-01",
          },
        },
      }),
    );
    expect(report).toEqual(
      Option.some({
        meters: [
          {
            label: "Premium requests",
            usedPercent: 30,
            resetsAt: Date.UTC(2026, 11, 1),
            resetDayOnly: true,
          },
        ],
      }),
    );
    expect(Option.isSome(report) && report.value.meters.every(Schema.is(UsageMeter))).toBe(true);
  });

  it("reports overage past 100% and orders premium, chat, completions", () => {
    const report = toCopilotReport(
      decode({
        quotaSnapshots: {
          completions: {
            isUnlimitedEntitlement: false,
            entitlementRequests: 2000,
            usedRequests: 400,
            remainingPercentage: 80,
            resetDate: "2026-12-01T00:00:00Z",
          },
          chat: {
            isUnlimitedEntitlement: false,
            entitlementRequests: 50,
            usedRequests: 50,
            remainingPercentage: 0,
            usageAllowedWithExhaustedQuota: false,
            resetDate: "2026-12-01T00:00:00Z",
          },
          premium_interactions: {
            isUnlimitedEntitlement: false,
            entitlementRequests: 100,
            usedRequests: 100,
            overage: 25,
            remainingPercentage: 0,
            overageAllowedWithExhaustedQuota: true,
            usageAllowedWithExhaustedQuota: true,
            resetDate: "2026-12-01T00:00:00Z",
          },
        },
      }),
    );
    expect(report).toEqual(
      Option.some({
        meters: [
          {
            label: "Premium requests",
            usedPercent: 125,
            resetsAt: Date.UTC(2026, 11, 1),
            level: "critical",
          },
          {
            label: "Chat",
            usedPercent: 100,
            resetsAt: Date.UTC(2026, 11, 1),
            level: "critical",
          },
          {
            label: "Completions",
            usedPercent: 20,
            resetsAt: Date.UTC(2026, 11, 1),
          },
        ],
      }),
    );
  });

  it("omits resetDate when Copilot echoes a past/current snapshot timestamp", () => {
    const now = Date.UTC(2026, 10, 21, 17, 54, 0);
    const report = toCopilotReport(
      decode({
        quotaSnapshots: {
          premium_interactions: {
            isUnlimitedEntitlement: false,
            entitlementRequests: 200,
            usedRequests: 193,
            remainingPercentage: 3.6,
            resetDate: "2026-11-21T17:53:02.109Z",
          },
        },
      }),
      now,
    );
    expect(report).toEqual(
      Option.some({
        meters: [{ label: "Premium requests", usedPercent: 96.4 }],
      }),
    );
  });

  it("returns None when every bucket is unlimited", () => {
    expect(
      toCopilotReport(
        decode({
          quotaSnapshots: {
            chat: { isUnlimitedEntitlement: true, entitlementRequests: -1 },
          },
        }),
      ),
    ).toEqual(Option.none());
  });
});
