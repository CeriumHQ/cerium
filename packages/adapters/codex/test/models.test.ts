import { describe, expect, it } from "@effect/vitest";

import { threadParams } from "../src/config.ts";
import { cacheSafeFromCatalog, OPEN_SPEEDS, speedPolicy, speedsOf, toModelInfo } from "../src/models.ts";
import type { Model } from "../src/protocol/v2/Model.ts";

const model = (slug: string) =>
  ({
    model: slug,
    displayName: slug,
    description: "",
    supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
    defaultReasoningEffort: "low",
    isDefault: false,
  }) as unknown as Model;

describe("toModelInfo", () => {
  it("follows Codex's catalog where it names the model", () => {
    const catalog = new Map([
      ["gpt-6-astra", true],
      ["gpt-6-luna", false],
    ]);
    expect(toModelInfo(model("gpt-6-astra"), catalog).cacheSafeEffort).toBe(true);
    expect(toModelInfo(model("gpt-6-luna"), catalog).cacheSafeEffort).toBeUndefined();
    // A model the catalog leaves out falls back to the measured ones.
    expect(toModelInfo(model("gpt-6-luna"), new Map()).cacheSafeEffort).toBe(true);
  });
});

describe("cacheSafeFromCatalog", () => {
  it("reads which models take an effort change without restarting the cache", () => {
    const text = JSON.stringify({
      fetched_at: "2026-10-24T03:50:24Z",
      etag: 'W/"d78c"',
      models: [
        { slug: "gpt-6-luna", supports_reasoning_effort_updates: true, visibility: "list" },
        { slug: "gpt-5.6-terra", supports_reasoning_effort_updates: false },
        { slug: "codex-auto-review" },
      ],
    });
    expect(cacheSafeFromCatalog(text)).toEqual(
      new Map([
        ["gpt-6-luna", true],
        ["gpt-5.6-terra", false],
        ["codex-auto-review", false],
      ]),
    );
  });

  it("reads a catalog it doesn't recognise as none", () => {
    expect(cacheSafeFromCatalog("not json")).toBeUndefined();
    expect(cacheSafeFromCatalog(JSON.stringify({ data: [] }))).toBeUndefined();
    expect(
      cacheSafeFromCatalog(
        JSON.stringify({ models: [{ slug: "a", supports_reasoning_effort_updates: "yes" }] }),
      ),
    ).toBeUndefined();
  });
});

describe("speedsOf", () => {
  const fast = { id: "priority", name: "Fast", description: "1.5x speed" };
  const ultrafast = { id: "ultrafast", name: "Ultrafast", description: "8x speed" };
  const tiers = (serviceTiers: Model["serviceTiers"], defaultServiceTier: string | null = null) => ({
    serviceTiers,
    defaultServiceTier,
  });

  it("offers the tiers the catalog lists for the model and the account's plan", () => {
    expect(speedsOf(tiers([fast]), OPEN_SPEEDS)).toEqual({
      speeds: ["standard", "fast"],
      defaultSpeed: "standard",
    });
    expect(speedsOf(tiers([ultrafast, fast]), OPEN_SPEEDS).speeds).toEqual(["standard", "fast", "ultrafast"]);
    // No faster tier, or only Flex (slower than standard): nothing to pick.
    expect(speedsOf(tiers([]), OPEN_SPEEDS)).toEqual({});
    expect(speedsOf(tiers([{ id: "flex", name: "Flex", description: "" }]), OPEN_SPEEDS)).toEqual({});
  });

  it("defaults to the configured tier where the model has it, else the catalog's", () => {
    const configured = (tier: string) => ({ ...OPEN_SPEEDS, configured: tier });
    expect(speedsOf(tiers([fast]), configured("priority")).defaultSpeed).toBe("fast");
    expect(speedsOf(tiers([fast]), configured("fast")).defaultSpeed).toBe("fast");
    expect(speedsOf(tiers([fast]), configured("default")).defaultSpeed).toBe("standard");
    // A tier the model lacks runs it at standard speed.
    expect(speedsOf(tiers([fast]), configured("ultrafast")).defaultSpeed).toBe("standard");
    expect(speedsOf(tiers([fast], "priority"), OPEN_SPEEDS).defaultSpeed).toBe("fast");
    expect(speedsOf(tiers([fast], "priority"), configured("default")).defaultSpeed).toBe("standard");
  });

  it("leaves out the tiers the policy turns off", () => {
    const both = tiers([fast, ultrafast]);
    expect(speedsOf(both, { fast: false, ultrafast: true }).speeds).toEqual(["standard", "ultrafast"]);
    expect(speedsOf(both, { fast: false, ultrafast: false })).toEqual({});
  });
});

describe("speedPolicy", () => {
  const requirements = (
    featureRequirements: Record<string, boolean>,
    supportsIndependentSpeedModes: boolean | null = true,
  ) =>
    ({
      supportsIndependentSpeedModes,
      requirements: { featureRequirements },
    }) as unknown as Parameters<typeof speedPolicy>[1];

  it("keeps every tier on unless the config or requirements turn one off", () => {
    expect(speedPolicy({ service_tier: null }, undefined)).toEqual({ fast: true, ultrafast: true });
    expect(speedPolicy({ service_tier: "priority" }, undefined).configured).toBe("priority");
    expect(speedPolicy({ service_tier: null, features: { fast_mode: false } }, undefined)).toEqual({
      fast: false,
      ultrafast: true,
    });
    expect(speedPolicy({ service_tier: null }, requirements({ ultrafast_mode: false }))).toEqual({
      fast: true,
      ultrafast: false,
    });
  });

  it("gates Ultrafast with Fast on a server without independent speed requirements", () => {
    expect(speedPolicy({ service_tier: null }, requirements({ fast_mode: false }, null))).toEqual({
      fast: false,
      ultrafast: false,
    });
    expect(speedPolicy({ service_tier: null }, requirements({ fast_mode: false }))).toEqual({
      fast: false,
      ultrafast: true,
    });
  });
});

describe("service tiers", () => {
  it("starts a thread on the speed picked, and on the user's own tier without one", () => {
    const options = { cwd: ".", model: "gpt-6-astra", access: "auto", mcpServers: {} } as const;
    const user = { mcpServers: [] };
    const start = (speed?: "standard" | "fast" | "ultrafast") =>
      threadParams({ ...options, includeUserMcpServers: false, ...(speed ? { speed } : {}) }, user);
    expect(start("standard").serviceTier).toBe("default");
    expect(start("fast").serviceTier).toBe("priority");
    expect(start("ultrafast").serviceTier).toBe("ultrafast");
    expect(start()).not.toHaveProperty("serviceTier");
  });
});
