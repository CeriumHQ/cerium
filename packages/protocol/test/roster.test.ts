import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  movedInOrder,
  rosterMembers,
  Settings,
  starterRoster,
  withHarnessReset,
  withHarnessRoster,
  type ModelInfo,
  type RosterSettings,
} from "../src/index.ts";

const model = (provider: ModelInfo["provider"], id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  provider,
  id,
  label: id.toUpperCase(),
  efforts: [],
  ...extra,
});

const offered = [
  model("claude", "fable"),
  model("claude", "opus", { description: "For complex work" }),
  model("claude", "haiku"),
  model("codex", "gpt-5.6-terra", { description: "Older balanced model" }),
  model("codex", "gpt-5.6-luna", { isDefault: true }),
  model("opencode", "opencode/nemotron", { description: "opencode/nemotron" }),
];
const empty: RosterSettings = { models: [], edited: [] };
const summary = (settings: RosterSettings) =>
  rosterMembers(settings, offered).map(({ model, use }) => `${model.provider}/${model.id}: ${use}`);

describe("starterRoster", () => {
  it("takes Cerium's picks a harness offers, else its default model, else its first", () => {
    expect(starterRoster("claude", offered).map((entry) => entry.model)).toEqual(["opus", "haiku"]);
    expect(starterRoster("codex", offered).map((entry) => entry.model)).toEqual(["gpt-5.6-luna"]);
    expect(starterRoster("opencode", offered).map((entry) => entry.model)).toEqual(["opencode/nemotron"]);
    expect(starterRoster("cursor", offered)).toEqual([]);
  });
});

describe("rosterMembers", () => {
  it("starts every harness on its picks, each with Cerium's line or the harness's own", () => {
    expect(summary(empty)).toEqual([
      "claude/opus: Hard problems, design and review",
      "claude/haiku: Quick lookups and simple tasks",
      "codex/gpt-5.6-luna: GPT-5.6-LUNA",
      // A description that only repeats the id says nothing, so the label stands in.
      "opencode/opencode/nemotron: OPENCODE/NEMOTRON",
    ]);
  });

  it("keeps an edited harness's own list, in its order, and leaves out what isn't offered", () => {
    const settings = withHarnessRoster(empty, "claude", [
      { provider: "claude", model: "haiku" },
      { provider: "claude", model: "fable", use: "  Architecture  " },
      { provider: "claude", model: "gone" },
    ]);
    expect(summary(settings).slice(0, 2)).toEqual([
      "claude/haiku: Quick lookups and simple tasks",
      "claude/fable: Architecture",
    ]);
    // Codex still starts on its picks.
    expect(summary(settings)[2]).toBe("codex/gpt-5.6-luna: GPT-5.6-LUNA");
  });

  it("ranks each harness's models by their place on its list, and keeps a speed the model offers", () => {
    const fast = [
      model("claude", "opus", { speeds: ["standard", "fast"] }),
      model("claude", "haiku"),
      model("codex", "gpt-5.6-luna", { speeds: ["standard", "fast", "ultrafast"] }),
    ];
    const settings = withHarnessRoster(
      withHarnessRoster(empty, "claude", [
        { provider: "claude", model: "gone" },
        { provider: "claude", model: "haiku", speed: "fast" },
        { provider: "claude", model: "opus", speed: "fast" },
      ]),
      "codex",
      [{ provider: "codex", model: "gpt-5.6-luna", speed: "ultrafast" }],
    );
    expect(
      rosterMembers(settings, fast).map(({ model, priority, speed }) => [model.id, priority, speed]),
    ).toEqual([
      // A model gone from the harness takes no rank; one with a single speed keeps none.
      ["haiku", 1, undefined],
      ["opus", 2, "fast"],
      ["gpt-5.6-luna", 1, "ultrafast"],
    ]);
  });

  it("lets a harness's roster be emptied, and put back", () => {
    const emptied = withHarnessRoster(empty, "codex", []);
    expect(summary(emptied).some((line) => line.startsWith("codex/"))).toBe(false);
    expect(summary(withHarnessReset(emptied, "codex"))).toEqual(summary(empty));
  });
});

describe("movedInOrder", () => {
  const order = ["a", "b", "c"];

  it("puts a model in another's place, shifting that one toward where it was", () => {
    expect(movedInOrder(order, "a", "b")).toEqual(["b", "a", "c"]);
    expect(movedInOrder(order, "a", "c")).toEqual(["b", "c", "a"]);
    expect(movedInOrder(order, "c", "a")).toEqual(["c", "a", "b"]);
    expect(movedInOrder(order, "b", "b")).toBe(order);
    expect(movedInOrder(order, "a", "gone")).toBe(order);
  });
});

describe("Settings.roster", () => {
  it("reads as empty from a backend that predates it, and skips what it can't read", () => {
    const decode = Schema.decodeUnknownSync(Settings);
    expect(decode({}).roster).toEqual(empty);
    expect(
      decode({
        roster: {
          models: [
            { provider: "someday", model: "x" },
            { provider: "codex", model: "y" },
          ],
          edited: ["codex"],
        },
      }).roster,
    ).toEqual({ models: [{ provider: "codex", model: "y" }], edited: ["codex"] });
  });
});
