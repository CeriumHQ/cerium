import { AcpTranslator } from "@cerium/adapter-acp";
import { describe, expect, it } from "@effect/vitest";
import { antigravityToolView } from "../src/harness.ts";

describe("Antigravity native tool input translation", () => {
  it("normalizes CommandLine for command rendering and permission policy", () => {
    const translator = new AcpTranslator({ provider: "antigravity", view: antigravityToolView });
    const call = translator.track({
      toolCallId: "shell",
      kind: "execute",
      title: "Run command?",
      rawInput: { CommandLine: "git status" },
    });
    expect(translator.view(call)).toMatchObject({ name: "Bash", input: { command: "git status" } });
  });
  it("normalizes file paths and preserves MCP identities for trusted-server policy", () => {
    const translator = new AcpTranslator({ provider: "antigravity", view: antigravityToolView });
    const edit = translator.track({
      toolCallId: "edit",
      kind: "edit",
      rawInput: { TargetFile: "/work/a.ts" },
    });
    expect(translator.view(edit)).toMatchObject({ name: "Edit", input: { file_path: "/work/a.ts" } });
    const mcp = translator.track({ toolCallId: "bus", name: "mcp__cerium__workspace_status", kind: "other" });
    expect(translator.view(mcp).name).toBe("mcp__cerium__workspace_status");
  });
});
