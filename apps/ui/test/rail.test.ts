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
  it("fills each ring with its tightest limit, leaving a spending cap out", () => {
    const [ring] = usageRings([claude], new Set(["claude"]), now);
    expect(ring?.left).toBe(30);
    expect(ring?.level).toBe("normal");
    expect(ring?.plan).toBe("max");
    expect(ring?.meters).toHaveLength(3);
  });

  it("grades a ring by its worst limit", () => {
    expect(usageRings([codex], new Set(["codex"]), now)[0]?.level).toBe("critical");
  });

  it("shows only harnesses that can run threads, and none that couldn't be read", () => {
    const unreadable: ProviderUsage = { _tag: "UsageUnreadable", provider: "codex", message: "Offline" };
    expect(usageRings([claude, unreadable], new Set(["codex"]), now)).toEqual([]);
  });

  it("counts a spending cap when it's the plan's only meter", () => {
    const capped: ProviderUsage = {
      _tag: "Subscribed",
      provider: "cursor",
      meters: [{ label: "Monthly", usedPercent: 25, spend: { used: 5, limit: 20, currency: "USD" } }],
      checkedAt: now,
    };
    expect(usageRings([capped], new Set(["cursor"]), now)[0]?.left).toBe(75);
  });
});
