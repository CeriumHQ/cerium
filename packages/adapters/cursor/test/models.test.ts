import type { ModelListItem } from "@cursor/sdk";
import { describe, expect, it } from "@effect/vitest";

import { clampEffort, toCeriumEffort, toModelInfo, toModelSelection } from "../src/models.ts";

// Catalog entries shaped like `Cursor.models.list()` results (`ModelListItem`); parameter ids and values
// vary by model, so these cover the spellings the adapter has to recognise.
const reasoningModel: ModelListItem = {
  id: "gpt-5.5",
  displayName: "GPT-5.5",
  description: "OpenAI's frontier model",
  aliases: ["gpt-5.5-latest"],
  parameters: [
    { id: "fast", displayName: "Fast", values: [{ value: "true" }, { value: "false" }] },
    {
      id: "reasoning",
      displayName: "Reasoning effort",
      values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "Extra High" }],
    },
  ],
  variants: [
    {
      params: [
        { id: "fast", value: "false" },
        { id: "reasoning", value: "medium" },
      ],
      displayName: "GPT-5.5",
      isDefault: true,
    },
  ],
};

const thinkingSwitch: ModelListItem = {
  id: "composer-2.5",
  displayName: "Composer 2.5",
  parameters: [{ id: "thinking", values: [{ value: "true" }, { value: "false" }] }],
};

const catalog = [reasoningModel, thinkingSwitch];

describe("toModelInfo", () => {
  it("lists the model's efforts lowest first with its default", () => {
    const info = toModelInfo(reasoningModel);
    expect(info).toEqual({
      provider: "cursor",
      id: "gpt-5.5",
      label: "GPT-5.5",
      description: "OpenAI's frontier model",
      efforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "medium",
      speeds: ["standard", "fast"],
      defaultSpeed: "standard",
    });
  });

  it("reads a Fast switch as the model's speeds, defaulting to what its default variant runs", () => {
    const fastByDefault: ModelListItem = {
      id: "composer-2.6",
      displayName: "Composer 2.6",
      parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }],
      variants: [{ params: [{ id: "fast", value: "true" }], displayName: "Composer 2.6", isDefault: true }],
    };
    expect(toModelInfo(fastByDefault)).toMatchObject({ speeds: ["standard", "fast"], defaultSpeed: "fast" });
  });

  it("treats an on/off thinking switch as no effort setting", () => {
    expect(toModelInfo(thinkingSwitch)).toEqual({
      provider: "cursor",
      id: "composer-2.5",
      label: "Composer 2.5",
      efforts: [],
    });
  });
});

describe("toModelSelection", () => {
  it("clamps efforts the model lacks to the closest one", () => {
    expect(toModelSelection("gpt-5.5", "max", catalog).params).toEqual([
      { id: "reasoning", value: "Extra High" },
    ]);
    expect(toModelSelection("gpt-5.5", "minimal", catalog).params).toEqual([
      { id: "reasoning", value: "low" },
    ]);
  });

  it("keeps bracket parameters and lets the effort replace theirs", () => {
    expect(toModelSelection("gpt-5.5[fast=true, reasoning=low]", "medium", catalog)).toEqual({
      id: "gpt-5.5",
      params: [
        { id: "fast", value: "true" },
        { id: "reasoning", value: "medium" },
      ],
    });
    expect(toModelSelection("gpt-5.5[reasoning=low]", undefined, catalog).params).toEqual([
      { id: "reasoning", value: "low" },
    ]);
  });

  it("resolves aliases and ignores effort for models without one", () => {
    expect(toModelSelection("gpt-5.5-latest", "low", catalog).params).toEqual([
      { id: "reasoning", value: "low" },
    ]);
    expect(toModelSelection("composer-2.5", "high", catalog)).toEqual({ id: "composer-2.5" });
    expect(toModelSelection("unlisted", "high", catalog)).toEqual({ id: "unlisted" });
  });
});

describe("effort names", () => {
  it("reads Cursor's spellings", () => {
    expect(["XHigh", "extra_high", "Maximum", "MAX", "min", "none"].map(toCeriumEffort)).toEqual([
      "xhigh",
      "xhigh",
      "max",
      "max",
      "minimal",
      undefined,
    ]);
  });

  it("breaks clamping ties toward the lower effort", () => {
    expect(clampEffort("medium", ["low", "high"])).toBe("low");
    expect(clampEffort("high", [])).toBeUndefined();
  });
});

describe("speed", () => {
  it("asks for the Fast tier, or standard speed, over the model's default", () => {
    expect(toModelSelection("gpt-5.5", "high", catalog, "fast").params).toEqual([
      { id: "reasoning", value: "high" },
      { id: "fast", value: "true" },
    ]);
    expect(toModelSelection("gpt-5.5[fast=true]", undefined, catalog, "standard").params).toEqual([
      { id: "fast", value: "false" },
    ]);
  });

  it("leaves the speed alone where none is picked or the model has no Fast switch", () => {
    expect(toModelSelection("gpt-5.5", undefined, catalog).params).toBeUndefined();
    expect(toModelSelection("composer-2.5", undefined, catalog, "fast")).toEqual({ id: "composer-2.5" });
  });
});
