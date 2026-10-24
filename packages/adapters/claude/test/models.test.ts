import { describe, expect, it } from "@effect/vitest";

import { inspectOptions } from "../src/models.ts";

describe("inspectOptions", () => {
  it("starts none of the user's MCP servers for a question about the account", () => {
    expect(inspectOptions("claude", undefined)).toMatchObject({ mcpServers: {}, strictMcpConfig: true });
  });

  it("asks about a folder as a session there would see it", () => {
    const options = inspectOptions("claude", "/work");
    expect(options.cwd).toBe("/work");
    expect(options.strictMcpConfig).toBeUndefined();
    expect(options.settingSources).toEqual(["user", "project", "local"]);
  });
});
