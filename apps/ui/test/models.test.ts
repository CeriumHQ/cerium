import type { HarnessStatus, ModelInfo } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import {
  accessLimit,
  allowedAccess,
  effortFor,
  effortsOf,
  findModels,
  MAX_AGENTS,
  modelKey,
  pickModel,
  pickModels,
  speedFor,
  speedsOf,
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
});

describe("speedFor", () => {
  const fastOpus = model("claude", "opus", { speeds: ["standard", "fast"], defaultSpeed: "standard" });
  const configuredFast = model("codex", "astra", {
    speeds: ["standard", "fast", "ultrafast"],
    defaultSpeed: "fast",
  });

  it("keeps the speed the model has, else its harness's default", () => {
    expect(speedFor(fastOpus, "fast")).toBe("fast");
    expect(speedFor(fastOpus, "ultrafast")).toBe("standard");
    expect(speedFor(configuredFast, undefined)).toBe("fast");
    expect(speedFor(configuredFast, "ultrafast")).toBe("ultrafast");
  });

  it("offers none for a model served at one speed", () => {
    expect(speedFor(haiku, "fast")).toBeUndefined();
    expect(speedFor(model("codex", "one", { speeds: ["standard"] }), "standard")).toBeUndefined();
  });

  it("lists every speed any of the models has, slowest first", () => {
    expect(speedsOf([configuredFast, haiku])).toEqual(["standard", "fast", "ultrafast"]);
    expect(speedsOf([haiku])).toEqual([]);
  });

  it("carries the speed over a switch where the new model has it", () => {
    expect(switchTo(fastOpus, "high", true, false, "fast")).toEqual({ model: "opus", speed: "fast" });
    expect(switchTo(haiku, undefined, true, false, "fast")).toEqual({ model: "haiku" });
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

describe("access a harness can't run", () => {
  const limit = { blocks: ["ask", "acceptEdits", "auto"] as const, reason: "Muse can't sandbox commands" };
  const harnesses: ReadonlyArray<HarnessStatus> = [
    {
      _tag: "HarnessInstalled",
      provider: "muse",
      executablePath: "muse-bin.exe",
      version: "1.4.12",
      auth: { _tag: "LoggedIn" },
      limit: { blocks: [...limit.blocks], reason: limit.reason },
    },
    {
      _tag: "HarnessInstalled",
      provider: "claude",
      executablePath: "claude.exe",
      version: "3.1.0",
      auth: { _tag: "LoggedIn" },
    },
  ];

  it("limits a start that includes the harness, and nothing else", () => {
    expect(accessLimit(harnesses, [opus, model("muse", "spark")])).toEqual({
      blocks: ["ask", "acceptEdits", "auto"],
      reason: "Muse can't sandbox commands",
    });
    expect(accessLimit(harnesses, [opus])).toBeUndefined();
  });

  it("starts in Full access when the pick is a mode the harness can't run", () => {
    const limited = accessLimit(harnesses, [model("muse", "spark")]);
    expect(allowedAccess("auto", limited)).toBe("fullAccess");
    expect(allowedAccess("readOnly", limited)).toBe("readOnly");
    expect(allowedAccess("auto", undefined)).toBe("auto");
  });
});
