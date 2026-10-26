import { describe, expect, it } from "@effect/vitest";

import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

import { inspectOptions, toModelInfos } from "../src/models.ts";

describe("inspectOptions", () => {
  it("starts none of the user's MCP servers for a question about the account", () => {
    expect(inspectOptions("claude", undefined)).toMatchObject({ mcpServers: {}, strictMcpConfig: true });
  });

  it("opts the account's question in to fast mode, so it says whether the account may use it", () => {
    expect(inspectOptions("claude", undefined).settings).toEqual({ fastMode: true });
    expect(inspectOptions("claude", "/work").settings).toBeUndefined();
  });

  it("asks about a folder as a session there would see it", () => {
    const options = inspectOptions("claude", "/work");
    expect(options.cwd).toBe("/work");
    expect(options.strictMcpConfig).toBeUndefined();
    expect(options.settingSources).toEqual(["user", "project", "local"]);
  });
});

describe("toModelInfos", () => {
  const rows: ReadonlyArray<ModelInfo> = [
    { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default", description: "" },
    {
      value: "opus",
      resolvedModel: "claude-opus-5-5",
      displayName: "Opus",
      description: "",
      supportsFastMode: true,
    },
    { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet", description: "" },
  ];

  it("offers fast mode on the models that support it, at standard speed unless picked", () => {
    const [opus, sonnet] = toModelInfos(rows, undefined);
    expect(opus).toMatchObject({ id: "opus", speeds: ["standard", "fast"], defaultSpeed: "standard" });
    expect(sonnet?.speeds).toBeUndefined();
    // Still checking the account, or an allowlist without the default fast model: offered.
    expect(toModelInfos(rows, "pending")[0]?.speeds).toEqual(["standard", "fast"]);
    expect(toModelInfos(rows, "model_not_allowed")[0]?.speeds).toEqual(["standard", "fast"]);
  });

  it("offers none where the account can't use it", () => {
    for (const reason of ["free", "extra_usage_disabled", "preference", "not_first_party"] as const) {
      expect(toModelInfos(rows, reason).every((model) => model.speeds === undefined)).toBe(true);
    }
  });
});
