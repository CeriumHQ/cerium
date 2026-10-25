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
  it("gives each limit an arc in the harness's order, leaving a spending cap out", () => {
    const [ring] = usageRings([claude], new Set(["claude"]), now);
    expect(ring?.arcs).toEqual([
      { label: "Current session", left: 60, level: "normal" },
      { label: "Weekly", left: 30, level: "normal" },
    ]);
    expect(ring?.left).toBe(30);
    expect(ring?.plan).toBe("max");
    expect(ring?.meters).toHaveLength(3);
  });

  it("grades each arc by its own limit", () => {
    expect(usageRings([codex], new Set(["codex"]), now)[0]?.arcs[0]?.level).toBe("critical");
  });

  it("keeps the tightest of the rest as the last arc past three limits", () => {
    const many: ProviderUsage = {
      _tag: "Subscribed",
      provider: "claude",
      meters: [
        { label: "Current session", usedPercent: 10 },
        { label: "Weekly · All models", usedPercent: 20 },
        { label: "Weekly · Opus", usedPercent: 30 },
        { label: "Weekly · Sonnet", usedPercent: 80 },
      ],
      checkedAt: now,
    };
    const labels = usageRings([many], new Set(["claude"]), now)[0]?.arcs.map((arc) => arc.label);
    expect(labels).toEqual(["Current session", "Weekly · All models", "Weekly · Sonnet"]);
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
