import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import {
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

  it("lets a harness's roster be emptied, and put back", () => {
    const emptied = withHarnessRoster(empty, "codex", []);
    expect(summary(emptied).some((line) => line.startsWith("codex/"))).toBe(false);
    expect(summary(withHarnessReset(emptied, "codex"))).toEqual(summary(empty));
  });
});

describe("Settings.roster", () => {
  it("reads as empty from a backend that predates it, and skips what it can't read", () => {
    const decode = Schema.decodeUnknownSync(Settings);
    expect(decode({ includeUserMcpServers: true }).roster).toEqual(empty);
    expect(
      decode({
        includeUserMcpServers: true,
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
