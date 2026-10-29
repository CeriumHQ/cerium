import type { ProviderUsage } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { usageRings } from "../src/app/railModel.ts";

const now = Date.UTC(2026, 9, 25, 12);

const claude: ProviderUsage = {
  _tag: "Subscribed",
  provider: "claude",
  plan: "max",
  meters: [
    { label: "Current session", usedPercent: 40 },
    { label: "Weekly", usedPercent: 70 },
    { label: "Extra usage", usedPercent: 95, spend: { used: 95, limit: 100, currency: "USD" } },
  ],
  checkedAt: now,
};

const codex: ProviderUsage = {
  _tag: "Subscribed",
  provider: "codex",
  meters: [{ label: "5-hour", usedPercent: 92 }],
  checkedAt: now,
};

describe("usageRings", () => {
  it("shows the limit with the least left, leaving a spending cap out", () => {
    const [ring] = usageRings([claude], new Set(["claude"]));
    expect(ring?.label).toBe("Weekly");
    expect(ring?.left).toBe(30);
    expect(ring?.plan).toBe("max");
    expect(ring?.meters).toHaveLength(3);
  });

  it("shows a harness's only limit", () => {
    expect(usageRings([codex], new Set(["codex"]))[0]?.left).toBe(8);
  });

  it("shows only harnesses that can run threads, and none that couldn't be read", () => {
    const unreadable: ProviderUsage = { _tag: "UsageUnreadable", provider: "codex", message: "Offline" };
    expect(usageRings([claude, unreadable], new Set(["codex"]))).toEqual([]);
  });

  it("counts a spending cap when it's the plan's only meter", () => {
    const capped: ProviderUsage = {
      _tag: "Subscribed",
      provider: "cursor",
      meters: [{ label: "Monthly", usedPercent: 25, spend: { used: 5, limit: 20, currency: "USD" } }],
      checkedAt: now,
    };
    expect(usageRings([capped], new Set(["cursor"]))[0]?.left).toBe(75);
  });
});
