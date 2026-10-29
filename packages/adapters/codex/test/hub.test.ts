import { describe, expect, it } from "@effect/vitest";

import { codexServers, toCodexServer } from "../src/hub.ts";
import type { ConfigLayer } from "../src/protocol/v2/ConfigLayer.ts";

const layer = (
  name: ConfigLayer["name"],
  config: unknown,
  disabledReason: string | null = null,
): ConfigLayer => ({ name, version: "1", config, disabledReason }) as ConfigLayer;

describe("codexServers", () => {
  it("scopes each server by the layer that defines it, with the project's switches merged in", () => {
    const user = layer(
      { type: "user", file: "/home/.codex/config.toml", profile: null },
      {
        mcp_servers: { gh: { command: "npx", env: { TOKEN: "t" } } },
      },
    );
    const project = layer(
      { type: "project", dotCodexFolder: "/work/app/.codex" },
      {
        mcp_servers: { gh: { enabled: false, disabled_tools: ["push"] }, local: { url: "https://l" } },
      },
    );
    const merged = {
      mcp_servers: {
        gh: { command: "npx", env: { TOKEN: "t" }, enabled: false, disabled_tools: ["push"] },
        local: { url: "https://l", bearer_token_env_var: "L_TOKEN" },
        plugin: { command: "p" },
      },
    };
    const servers = codexServers(merged, [project, user]);
    expect(
      servers.map((server) => [server.name, server.scope, server.enabled, server.disabledTools]),
    ).toEqual([
      ["gh", "user", false, ["push"]],
      ["local", "project", true, []],
      ["plugin", "bundled", true, []],
    ]);
    expect(servers[0]?.env).toEqual([{ name: "TOKEN", set: true }]);
    expect(servers[1]?.headers).toEqual([{ name: "Authorization", set: true }]);
  });

  it("treats an untrusted project's layer as not there", () => {
    const project = layer(
      { type: "project", dotCodexFolder: "/w/.codex" },
      { mcp_servers: { a: { command: "x" } } },
      "Trust it first",
    );
    expect(codexServers({ mcp_servers: { a: { command: "x" } } }, [project])[0]?.scope).toBe("bundled");
  });

  it("writes a copied server in Codex's shape, secrets blank", () => {
    expect(
      toCodexServer({ name: "w", transport: "http", url: "https://w", env: [], headers: ["Authorization"] }),
    ).toEqual({
      url: "https://w",
      http_headers: { Authorization: "" },
    });
  });
});
