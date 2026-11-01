import { Initialized } from "@cerium/adapter-acp";
import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { contextWindowOf, lowestEffort, modelStateOf, toModelInfos } from "../src/models.ts";

// The models Grok Build 1.0.70 listed when it started (`scripts/record-fixture.ts`).
const initialized = Schema.decodeUnknownSync(Initialized)(
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "initialize.json"), "utf8")),
);

describe("Grok models", () => {
  it("lists each model with its efforts lowest first, its default effort and the one Grok runs", () => {
    const state = modelStateOf(initialized);
    expect(state).toBeDefined();
    expect(toModelInfos(state!)).toEqual([
      {
        provider: "grok",
        id: "grok-4.7",
        label: "Grok 4.7",
        description: "SpaceXAI's latest frontier model",
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "high",
      },
      {
        provider: "grok",
        id: "grok-4.7-build-fast",
        label: "Grok 4.7 Fast",
        description: "Fast variant. 2x the price.",
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "xhigh",
        isDefault: true,
      },
      {
        provider: "grok",
        id: "grok-4.6",
        label: "Grok 4.6",
        efforts: ["low", "medium", "high", "xhigh"],
        defaultEffort: "high",
      },
      {
        provider: "grok",
        id: "grok-4.5",
        label: "Grok 4.5",
        efforts: ["low", "medium", "high"],
        defaultEffort: "high",
      },
    ]);
  });

  it("reads a model's context window and lowest effort", () => {
    expect(contextWindowOf(initialized, "grok-4.6")).toBe(256000);
    expect(contextWindowOf(initialized, "grok-9")).toBeUndefined();
    expect(lowestEffort(modelStateOf(initialized), "grok-4.5")).toBe("low");
    expect(lowestEffort(modelStateOf(initialized), "grok-9")).toBeUndefined();
  });

  it("lists no models from an agent that didn't say", () => {
    expect(modelStateOf({ ...initialized, _meta: {} })).toBeUndefined();
  });
});
