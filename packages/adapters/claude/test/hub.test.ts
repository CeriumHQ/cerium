import { describe, expect, it } from "@effect/vitest";

import { claudeListing, toolRule } from "../src/hub.ts";

const project = "C:\\work\\app";

describe("claudeListing", () => {
  it("lists each scope's servers, the closest winning, with what the project turned off", () => {
    const global = JSON.stringify({
      mcpServers: { gh: { command: "npx", env: { TOKEN: "t" } }, docs: { type: "http", url: "https://d" } },
      projects: {
        "C:/work/app": {
          mcpServers: { gh: { command: "local-gh" } },
          disabledMcpServers: ["docs"],
          disabledMcpjsonServers: ["pending"],
        },
      },
    });
    const mcpJson = JSON.stringify({ mcpServers: { pending: { command: "x" }, shared: { command: "y" } } });
    const settings = ["", "", JSON.stringify({ permissions: { deny: ["mcp__shared__drop", "Bash(rm:*)"] } })];
    const { servers } = claudeListing({ project, global, mcpJson, settings, skills: [] });
    expect(
      servers.map((server) => [server.name, server.scope, server.enabled, server.disabledTools]),
    ).toEqual([
      ["gh", "local", true, []],
      ["docs", "user", false, []],
      ["pending", "project", false, []],
      ["shared", "project", true, ["drop"]],
    ]);
    expect(servers[0]?.command).toBe("local-gh");
  });

  it("turns off skills the settings override, the local file winning", () => {
    const skill = { name: "review", scope: "user" as const, path: "p", enabled: true };
    const settings = [
      JSON.stringify({ skillOverrides: { review: "off" } }),
      "",
      JSON.stringify({ skillOverrides: { review: "on" } }),
    ];
    expect(
      claudeListing({ project, global: "", mcpJson: "", settings, skills: [skill] }).skills[0]?.enabled,
    ).toBe(true);
    expect(
      claudeListing({ project, global: "", mcpJson: "", settings: settings.slice(0, 2), skills: [skill] })
        .skills[0]?.enabled,
    ).toBe(false);
  });

  it("names a tool as Claude Code's deny rules do", () => {
    expect(toolRule("my server", "get.style")).toBe("mcp__my_server__get_style");
  });
});
