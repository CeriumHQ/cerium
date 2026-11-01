import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { effortOf, effortsOf, effortValue, modelsOf } from "../src/models.ts";
import { SessionSetup } from "../src/schema.ts";

const decode = Schema.decodeUnknownSync(SessionSetup);

const setup = decode({
  sessionId: "s",
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "b",
      options: [
        { group: "fast", name: "Fast", options: [{ value: "a", name: "Model A", description: "Quick" }] },
        { group: "smart", name: "Smart", options: [{ value: "b", name: "Model B" }] },
      ],
    },
    {
      id: "reasoning_effort",
      name: "Reasoning Effort",
      category: "thought_level",
      type: "select",
      currentValue: "xhigh",
      options: [
        { value: "xhigh", name: "Extra High" },
        { value: "high", name: "High" },
        { value: "low", name: "Low" },
      ],
    },
    { id: "yolo", name: "Yolo", type: "boolean", currentValue: false },
  ],
});

describe("ACP models", () => {
  it("lists the model option's choices, groups flattened, with the thought levels as efforts", () => {
    expect(modelsOf("grok", setup)).toEqual([
      {
        provider: "grok",
        id: "a",
        label: "Model A",
        description: "Quick",
        efforts: ["low", "high", "xhigh"],
        defaultEffort: "xhigh",
      },
      {
        provider: "grok",
        id: "b",
        label: "Model B",
        efforts: ["low", "high", "xhigh"],
        defaultEffort: "xhigh",
        isDefault: true,
      },
    ]);
  });

  it("falls back to the older model picker", () => {
    const older = decode({
      sessionId: "s",
      models: {
        currentModelId: "m1",
        availableModels: [
          { modelId: "m1", name: "One" },
          { modelId: "m2", name: "Two" },
        ],
      },
    });
    expect(modelsOf("antigravity", older).map((model) => [model.id, model.isDefault === true])).toEqual([
      ["m1", true],
      ["m2", false],
    ]);
  });

  it("reads thought levels by value or name and sets the nearest one offered", () => {
    expect(effortOf("extra_high")).toBe("xhigh");
    expect(effortOf("Extra High")).toBe("xhigh");
    expect(effortOf("turbo")).toBeUndefined();
    const choices = [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ];
    expect(effortsOf(choices)).toEqual(["low", "high"]);
    expect(effortValue(choices, "high")).toBe("high");
    expect(effortValue(choices, "minimal")).toBe("low");
    // Medium is as far from both; the higher one answers no worse than asked.
    expect(effortValue(choices, "medium")).toBe("high");
    expect(effortValue(choices, "max")).toBe("high");
  });
});
