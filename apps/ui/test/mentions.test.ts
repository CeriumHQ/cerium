import { mentionToken, type ModelInfo, type ProjectInfo } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { modelOptions, projectOptions } from "../src/features/composer/MentionMenu.tsx";

const projects: ReadonlyArray<ProjectInfo> = [
  { path: "/Users/dev/apps/cerium", usedAt: 2 },
  { path: "/Users/dev/apps/website", usedAt: 1 },
  { path: "/Users/dev/apps/gone", usedAt: 0, missing: true },
];

const models: ReadonlyArray<ModelInfo> = [
  { provider: "codex", id: "gpt-6.1-sol", label: "GPT-6.1 Sol", efforts: ["low", "medium", "high"] },
  { provider: "claude", id: "claude-sonnet-4-6", label: "Sonnet 4.6", efforts: ["low", "high"] },
];

describe("projectOptions and modelOptions", () => {
  it("lists non-missing saved projects and formats @project tokens", () => {
    const matches = projectOptions(projects, "cer");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.mention).toEqual({
      _tag: "ProjectMention",
      name: "cerium",
      path: "/Users/dev/apps/cerium",
    });
    expect(mentionToken(matches[0]!.mention)).toBe("@cerium");
    expect(projectOptions(projects, "").map((option) => option.label)).toEqual(["cerium", "website"]);
  });

  it("matches models by id, label, or provider and formats @model tokens", () => {
    const byId = modelOptions(models, new Set(["codex:gpt-6.1-sol"]), "gpt-6.1");
    expect(byId).toHaveLength(1);
    expect(byId[0]?.mention).toEqual({
      _tag: "ModelMention",
      provider: "codex",
      model: "gpt-6.1-sol",
      label: "GPT-6.1 Sol",
    });
    expect(mentionToken(byId[0]!.mention)).toBe("@gpt-6.1-sol");

    const all = modelOptions(models, new Set(["codex:gpt-6.1-sol"]), "");
    expect(all[0]?.label).toBe("GPT-6.1 Sol");
  });

  it("matches model ids and labels across separators, keeping literal matches first", () => {
    const gemini: ModelInfo = {
      provider: "antigravity",
      id: "gemini-3.5-flash",
      label: "Gemini 3.5 Flash",
      efforts: [],
    };
    const similar: ModelInfo = { ...gemini, id: "gemini3.5-pro", label: "Gemini 3.5 Pro" };
    const roster = new Set(["antigravity:gemini-3.5-flash"]);
    expect(modelOptions([gemini, similar], roster, "GEMINI3.5").map(({ label }) => label)).toEqual([
      similar.label,
      gemini.label,
    ]);
    expect(modelOptions([gemini], roster, "3_5flash")[0]?.label).toBe(gemini.label);
    expect(modelOptions([gemini], roster, "gemini3.1")).toEqual([]);
    expect(modelOptions([gemini], roster, "_")).toEqual([]);
  });

  it("matches saved project names and paths across separators", () => {
    const project: ProjectInfo = { path: "/Users/dev/my-projects/web_site", usedAt: 0 };
    expect(projectOptions([project], "website")[0]?.label).toBe("web_site");
    expect(projectOptions([project], "myprojects/web-site")[0]?.label).toBe("web_site");
  });
});
