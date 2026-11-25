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
});
