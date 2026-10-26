import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { AccessMode } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { toSdkOptions } from "../src/session.ts";

const canUseTool: CanUseTool = async (_toolName, input) => ({ behavior: "allow", updatedInput: input });
const optionsFor = (access: AccessMode) =>
  toSdkOptions(
    "claude",
    { cwd: ".", model: "opus", access, mcpServers: {}, includeUserMcpServers: false },
    canUseTool,
  );

describe("access modes", () => {
  it("limits readOnly to reading tools", () => {
    expect(optionsFor("readOnly")).toMatchObject({ permissionMode: "default", tools: expect.any(Array) });
    expect(optionsFor("ask").tools).toBeUndefined();
  });

  it("uses Claude Code's own permission modes", () => {
    expect(optionsFor("ask").permissionMode).toBe("default");
    expect(optionsFor("acceptEdits").permissionMode).toBe("acceptEdits");
    expect(optionsFor("auto").permissionMode).toBe("auto");
  });

  it("bypasses permissions only in fullAccess, with the SDK's explicit opt-in", () => {
    expect(optionsFor("fullAccess")).toMatchObject({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
    // Nothing is asked under bypass, so no approval callback is passed.
    expect(optionsFor("fullAccess").canUseTool).toBeUndefined();
    for (const access of ["readOnly", "ask", "acceptEdits", "auto"] as const) {
      expect(optionsFor(access).allowDangerouslySkipPermissions).toBeUndefined();
      expect(optionsFor(access).canUseTool).toBe(canUseTool);
    }
  });

  it("withholds Claude Code's own question tool in every mode", () => {
    for (const access of ["readOnly", "ask", "acceptEdits", "auto", "fullAccess"] as const) {
      expect(optionsFor(access).disallowedTools).toContain("AskUserQuestion");
    }
  });
});

describe("speed", () => {
  const withSpeed = (speed: "standard" | "fast" | undefined) =>
    toSdkOptions(
      "claude",
      {
        cwd: ".",
        model: "opus",
        ...(speed ? { speed } : {}),
        access: "auto",
        mcpServers: {},
        includeUserMcpServers: false,
      },
      canUseTool,
    );

  it("opts the session in to fast mode only when it runs fast", () => {
    expect(withSpeed("fast").settings).toEqual({ fastMode: true });
    expect(withSpeed("standard").settings).toBeUndefined();
    expect(withSpeed(undefined).settings).toBeUndefined();
  });
});
