import { describe, expect, it } from "@effect/vitest";

import { completionPrompt, quickestVariant } from "../src/complete.ts";
import { configContent } from "../src/host.ts";
import { parseModel, toModelInfos, toModelRef, variantFor, type CatalogRow } from "../src/models.ts";
import { bunShimTarget } from "../src/probe.ts";

const row = (
  providerID: string,
  id: string,
  variants: ReadonlyArray<string> = [],
  extra: Partial<CatalogRow> = {},
) =>
  ({
    id,
    providerID,
    name: id,
    variants: variants.map((variant) => ({ id: variant })),
    capabilities: { input: ["text"] },
    status: "active",
    enabled: true,
    ...extra,
  }) satisfies CatalogRow;

describe("parseModel", () => {
  it("splits at the first slash, so model ids keep theirs", () => {
    expect(parseModel("opencode/big-pickle")).toEqual({ providerID: "opencode", id: "big-pickle" });
    expect(parseModel("openrouter/meta/llama-5")).toEqual({ providerID: "openrouter", id: "meta/llama-5" });
    expect(parseModel("big-pickle")).toBeUndefined();
    expect(parseModel("opencode/")).toBeUndefined();
  });
});

describe("variantFor", () => {
  it("picks the effort's own variant, else the nearest, the lower on a tie", () => {
    expect(variantFor("high", ["low", "high", "max"])).toBe("high");
    expect(variantFor("xhigh", ["low", "high", "max"])).toBe("high");
    expect(variantFor("medium", ["low", "high"])).toBe("low");
    expect(variantFor("minimal", ["none", "thinking"])).toBeUndefined();
    expect(variantFor(undefined, ["low"])).toBeUndefined();
  });
});

describe("toModelRef", () => {
  const rows = [row("anthropic", "claude-sonnet-5-5", ["low", "high", "max"])];

  it("adds the variant for the effort to a listed model", () => {
    expect(toModelRef("anthropic/claude-sonnet-5-5", "medium", rows)).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-5-5",
      variant: "low",
    });
  });

  it("passes an unlisted model on without a variant", () => {
    expect(toModelRef("openai/gpt-6", "high", rows)).toEqual({ providerID: "openai", id: "gpt-6" });
  });
});

describe("toModelInfos", () => {
  it("drops deprecated and disabled models and puts the default first", () => {
    const fast = row("opencode", "big-pickle", ["low", "high", "none"]);
    const infos = toModelInfos(
      [
        row("anthropic", "claude-old", [], { status: "deprecated" }),
        row("anthropic", "claude-off", [], { enabled: false }),
        row("anthropic", "claude-sonnet-5-5", ["high"]),
        fast,
      ],
      fast,
    );
    expect(infos).toEqual([
      {
        provider: "opencode",
        id: "opencode/big-pickle",
        label: "big-pickle",
        description: "opencode/big-pickle",
        efforts: ["low", "high"],
        isDefault: true,
      },
      {
        provider: "opencode",
        id: "anthropic/claude-sonnet-5-5",
        label: "claude-sonnet-5-5",
        description: "anthropic/claude-sonnet-5-5",
        efforts: ["high"],
      },
    ]);
  });
});

describe("completions", () => {
  it("run a model with reasoning off where it can be, else at its lowest effort", () => {
    expect(quickestVariant(row("a", "b", ["none", "low", "high"]))).toBe("none");
    expect(quickestVariant(row("a", "b", ["medium", "high"]))).toBe("medium");
    expect(quickestVariant(row("a", "b"))).toBeUndefined();
    expect(quickestVariant(undefined)).toBeUndefined();
  });

  it("open the prompt with Cerium's instructions", () => {
    const prompt = completionPrompt({ instructions: "Name the thread.", prompt: "Fix the login bug" });
    expect(prompt.startsWith("<cerium_instructions>")).toBe(true);
    expect(prompt).toContain("Name the thread.");
    expect(prompt.endsWith("Fix the login bug")).toBe(true);
  });
});

describe("configContent", () => {
  it("keeps the user's inline configuration and their MCP servers beside Cerium's", () => {
    const inherited = JSON.stringify({
      theme: "dark",
      mcp: { timeout: 5, servers: { mine: { type: "local", command: ["x"] } } },
    });
    expect(
      JSON.parse(configContent({ mcp: { servers: { cerium: { type: "remote", url: "u" } } } }, inherited)),
    ).toEqual({
      theme: "dark",
      mcp: {
        timeout: 5,
        servers: { mine: { type: "local", command: ["x"] }, cerium: { type: "remote", url: "u" } },
      },
    });
  });

  it("ignores inherited configuration that isn't JSON", () => {
    expect(JSON.parse(configContent({ a: 1 }, "{not json"))).toEqual({ a: 1 });
    expect(JSON.parse(configContent({ a: 1 }, undefined))).toEqual({ a: 1 });
  });
});

describe("bunShimTarget", () => {
  it("reads the binary a Bun shim starts", () => {
    const shim = new Uint8Array([
      ...Buffer.from('install\\global\\node_modules\\@opencode\\cli\\bin\\opencode.exe"\0', "utf16le"),
      0x30,
      0xab,
    ]);
    expect(bunShimTarget(shim)).toBe("install\\global\\node_modules\\@opencode\\cli\\bin\\opencode.exe");
    expect(bunShimTarget(new Uint8Array())).toBeUndefined();
  });
});
