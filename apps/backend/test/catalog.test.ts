import type { CatalogEntry } from "@cerium/orchestrator";
import type { ModelInfo } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { catalogFrom } from "../src/layers.ts";

const curated: ReadonlyArray<CatalogEntry> = [
  { alias: "opus", provider: "claude", model: "opus", description: "Hard problems" },
];
const model = (provider: ModelInfo["provider"], id: string, description?: string): ModelInfo => ({
  provider,
  id,
  label: id.toUpperCase(),
  efforts: [],
  ...(description ? { description } : {}),
});

describe("catalogFrom", () => {
  it("keeps hand-picked entries first and adds what the harnesses offer", () => {
    expect(
      catalogFrom(curated, [
        model("claude", "opus"),
        model("codex", "gpt-6-luna", "Fast"),
        model("muse", "spark"),
      ]),
    ).toEqual([
      curated[0],
      { alias: "gpt-6-luna", provider: "codex", model: "gpt-6-luna", description: "Fast" },
      { alias: "spark", provider: "muse", model: "spark", description: "SPARK" },
    ]);
  });

  it("prefixes ids that collide with an alias or another provider's id", () => {
    const entries = catalogFrom(curated, [
      model("cursor", "opus"),
      model("cursor", "sonnet"),
      model("claude", "sonnet"),
    ]);
    expect(entries.map((entry) => entry.alias)).toEqual([
      "opus",
      "cursor/opus",
      "cursor/sonnet",
      "claude/sonnet",
    ]);
  });
});
