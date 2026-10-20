import type { ModelInfo } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import {
  effortFor,
  effortsOf,
  findModels,
  MAX_AGENTS,
  modelKey,
  pickModel,
  pickModels,
  switchTo,
} from "../src/features/composer/models.ts";

const model = (provider: ModelInfo["provider"], id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  provider,
  id,
  label: id,
  efforts: [],
  ...extra,
});

const opus = model("claude", "opus", {
  efforts: ["low", "medium", "high", "max"],
  defaultEffort: "high",
  isDefault: true,
});
const haiku = model("claude", "haiku");
const luna = model("codex", "luna", { efforts: ["low", "medium", "high"] });

describe("effortFor", () => {
  it("keeps the effort the model has, else its default, else its strongest", () => {
    expect(effortFor(opus, "low")).toBe("low");
    expect(effortFor(luna, "max")).toBe("high");
    expect(effortFor(opus, undefined)).toBe("high");
    expect(effortFor(model("codex", "plain", { efforts: ["low", "medium"] }), "max")).toBe("medium");
  });

  it("offers none for a model without an effort setting", () => {
    expect(effortFor(haiku, "high")).toBeUndefined();
  });
});

describe("switchTo", () => {
  it("carries the effort over where the new model has it", () => {
    expect(switchTo(opus, "medium", true)).toEqual({ model: "opus", effort: "medium" });
  });

  it("settles on the model's own effort when it lacks the one carried over", () => {
    expect(switchTo(luna, "max", true)).toEqual({ model: "luna", effort: "high" });
  });

  it("names no effort for a model that has none", () => {
    expect(switchTo(haiku, "high", true)).toEqual({ model: "haiku" });
  });

  it("keeps the thread's own effort when the harness can't change it", () => {
    expect(switchTo(opus, "low", false)).toEqual({ model: "opus", effort: "low" });
    expect(switchTo(opus, undefined, false)).toEqual({ model: "opus" });
  });
});

describe("pickModel", () => {
  const models = [opus, haiku, luna];

  it("keeps the chosen model while its harness can run it", () => {
    expect(pickModel(models, "codex/luna", new Set(["claude", "codex"]))?.id).toBe("luna");
  });

  it("falls back to the first usable harness's default", () => {
    expect(pickModel(models, "codex/luna", new Set(["claude"]))?.id).toBe("opus");
  });
});

describe("pickModels", () => {
  const all = [opus, haiku, luna, model("codex", "sol"), model("codex", "terra")];
  const both = new Set<ModelInfo["provider"]>(["claude", "codex"]);

  it("keeps each chosen model once, in the order chosen", () => {
    expect(pickModels(all, ["codex/luna", "claude/opus", "codex/luna"], both).map((each) => each.id)).toEqual(
      ["luna", "opus"],
    );
  });

  it("drops models whose harness can't run and ones no longer listed", () => {
    expect(
      pickModels(all, ["codex/luna", "claude/gone", "claude/opus"], new Set(["claude"])).map(
        (each) => each.id,
      ),
    ).toEqual(["opus"]);
  });

  it("starts no more than MAX_AGENTS", () => {
    expect(pickModels(all, all.map(modelKey), both)).toHaveLength(MAX_AGENTS);
  });
});

describe("effortsOf", () => {
  it("offers every effort any of the models has, weakest first", () => {
    expect(effortsOf([luna, opus, haiku])).toEqual(["low", "medium", "high", "max"]);
    expect(effortsOf([haiku])).toEqual([]);
  });
});

describe("findModels", () => {
  const sonnet = model("claude", "sonnet", { label: "Sonnet 5.5" });
  const cursorOpus = model("cursor", "claude-opus", { label: "Claude Opus 5.5" });
  const claudeOpus = model("claude", "opus", { label: "Opus 5.5" });
  const list = [sonnet, claudeOpus, luna, cursorOpus];

  it("lists every model while nothing is typed", () => {
    expect(findModels(list, "  ")).toEqual(list);
  });

  it("puts labels that start with what's typed before ones that contain it", () => {
    expect(findModels(list, "opus")).toEqual([claudeOpus, cursorOpus]);
  });

  it("matches the harness's name with the model's, word by word", () => {
    expect(findModels(list, "cursor opus")).toEqual([cursorOpus]);
    expect(findModels(list, "CLAUDE")).toEqual([cursorOpus, sonnet, claudeOpus]);
  });

  it("finds none when a word matches nothing", () => {
    expect(findModels(list, "opus gemini")).toEqual([]);
  });
});
