import type { ModelInfo, ProviderUsage, UsageMeter } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { handoffTarget, runningLow } from "../src/features/composer/handoff.ts";

const meter = (label: string, usedPercent: number): UsageMeter => ({ label, usedPercent });
const subscribed = (
  provider: ProviderUsage["provider"],
  meters: ReadonlyArray<UsageMeter>,
): ProviderUsage => ({
  _tag: "Subscribed",
  provider,
  meters,
  checkedAt: 1_000_000,
});
const model = (provider: ModelInfo["provider"], id: string, isDefault = false): ModelInfo => ({
  provider,
  id,
  label: id,
  efforts: [],
  ...(isDefault ? { isDefault } : {}),
});

describe("running low", () => {
  it("names the most nearly spent meter once 5% or less is left, on any harness, red once spent", () => {
    const usage = [
      subscribed("claude", [meter("Current session", 96), meter("Weekly", 98)]),
      subscribed("codex", [meter("5 hours", 10), meter("Weekly", 95)]),
    ];
    expect(runningLow(usage, "claude")).toMatchObject({ meter: { label: "Weekly" }, level: "warning" });
    expect(runningLow(usage, "codex")).toMatchObject({ meter: { label: "Weekly" }, level: "warning" });
    expect(runningLow([subscribed("claude", [meter("Current session", 94)])], "claude")).toBeUndefined();
    expect(runningLow([subscribed("codex", [meter("5 hours", 100)])], "codex")).toMatchObject({
      level: "critical",
    });
  });

  it("stays quiet with more than 5% left, however fast it's going", () => {
    const fast = { ...meter("Current session", 77), resetsAt: 1_000_000 + 4 * 3_600_000, windowMinutes: 300 };
    expect(runningLow([subscribed("claude", [fast])], "claude")).toBeUndefined();
  });

  it("offers the default model of the first other harness that can run and has room", () => {
    const models = [
      model("claude", "opus", true),
      model("codex", "gpt-6", false),
      model("codex", "gpt-6-luna", true),
      model("cursor", "composer-2.5", true),
    ];
    const usage = [subscribed("claude", [meter("Weekly", 95)]), subscribed("codex", [meter("5 hours", 97)])];
    const all = new Set(["claude", "codex", "cursor"] as const);
    expect(handoffTarget(models, all, usage, "claude")?.id).toBe("composer-2.5");
    expect(handoffTarget(models, all, [], "claude")?.id).toBe("gpt-6-luna");
    expect(handoffTarget(models, new Set(["claude"] as const), [], "claude")).toBeUndefined();
  });
});
