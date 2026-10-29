import { describe, expect, it } from "@effect/vitest";

import { allowedBy, openCodeServers, toOpenCodeServer, withPolicy } from "../src/hub.ts";

const project = "/work/app";

describe("openCodeServers", () => {
  it("reads both config shapes and applies the project's policies", () => {
    const documents = [
      {
        path: "/elsewhere/opencode.json",
        info: { mcp: { old: { type: "local", command: ["npx", "old"], enabled: true } } },
      },
      {
        path: "/work/app/opencode.json",
        info: {
          mcp: { servers: { web: { type: "remote", url: "https://w", headers: { Authorization: "t" } } } },
          policies: [{ action: "integration.use", resource: "mcp:old", effect: "deny" }],
        },
      },
    ];
    const servers = openCodeServers(documents, project);
    expect(servers.map((server) => [server.name, server.scope, server.enabled, server.transport])).toEqual([
      ["old", "bundled", false, "stdio"],
      ["web", "project", true, "http"],
    ]);
    expect(servers[1]?.headers).toEqual([{ name: "Authorization", set: true }]);
  });
});

describe("policies", () => {
  it("lets the last matching rule decide", () => {
    const rules = [
      { action: "integration.use", resource: "mcp:*", effect: "deny" },
      { action: "integration.use", resource: "mcp:web", effect: "allow" },
    ];
    expect(allowedBy(rules, "mcp:web")).toBe(true);
    expect(allowedBy(rules, "mcp:other")).toBe(false);
  });

  it("replaces a resource's own rule, allowing only to undo a wider deny", () => {
    const current = [
      { action: "tool.use", resource: "x", effect: "deny" },
      { action: "integration.use", resource: "mcp:a", effect: "deny" },
    ];
    expect(withPolicy(current, "mcp:a", true, false)).toEqual([current[0]]);
    expect(withPolicy(current, "mcp:a", true, true)).toEqual([
      current[0],
      { action: "integration.use", resource: "mcp:a", effect: "allow" },
    ]);
    expect(withPolicy(undefined, "skill:s", false, false)).toEqual([
      { action: "integration.use", resource: "skill:s", effect: "deny" },
    ]);
  });

  it("writes a copied server in OpenCode's shape, secrets blank", () => {
    expect(
      toOpenCodeServer({
        name: "gh",
        transport: "stdio",
        command: "npx",
        args: ["gh"],
        env: ["TOKEN"],
        headers: [],
      }),
    ).toEqual({
      type: "local",
      command: ["npx", "gh"],
      environment: { TOKEN: "" },
    });
  });
});
