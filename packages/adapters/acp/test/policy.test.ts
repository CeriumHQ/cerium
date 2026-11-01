import { describe, expect, it } from "@effect/vitest";

import { grantKey, mcpServerOf, outcomeFor, toAcpMcpServer, verdictFor } from "../src/policy.ts";

const call = (toolName: string, kind?: string, extra: { readOnly?: boolean; grant?: string } = {}) => ({
  toolName,
  grant: extra.grant ?? toolName,
  ...(kind === undefined ? {} : { kind }),
  ...(extra.readOnly === undefined ? {} : { readOnly: extra.readOnly }),
});

const none = new Set<string>();

describe("verdictFor", () => {
  it("runs the trusted bus's tools in every mode", () => {
    for (const access of ["readOnly", "ask", "acceptEdits", "auto", "fullAccess"] as const) {
      expect(verdictFor(access, call("mcp__cerium__spawn_agent", "other"), ["cerium"], none)._tag).toBe(
        "allow",
      );
    }
  });

  it("lets a read-only session read and nothing else", () => {
    expect(verdictFor("readOnly", call("Read", "read"), [], none)._tag).toBe("allow");
    expect(verdictFor("readOnly", call("Grep", "search"), [], none)._tag).toBe("allow");
    expect(verdictFor("readOnly", call("Edit", "edit"), [], none)._tag).toBe("deny");
    expect(verdictFor("readOnly", call("Bash", "execute"), [], none)._tag).toBe("deny");
    expect(verdictFor("readOnly", call("mcp__github__create_issue", "other"), [], none)._tag).toBe("deny");
    // A tool the agent marks as reading only runs, whatever its kind.
    expect(verdictFor("readOnly", call("search_tool", "other", { readOnly: true }), [], none)._tag).toBe(
      "allow",
    );
  });

  it("asks about writes and commands, unless the user allowed them for the session", () => {
    expect(verdictFor("ask", call("Edit", "edit"), [], none)._tag).toBe("ask");
    expect(verdictFor("auto", call("Bash", "execute", { grant: "Bash:npm" }), [], none)._tag).toBe("ask");
    expect(
      verdictFor("ask", call("Bash", "execute", { grant: "Bash:npm" }), [], new Set(["Bash:npm"]))._tag,
    ).toBe("allow");
    expect(
      verdictFor("ask", call("Bash", "execute", { grant: "Bash:rm" }), [], new Set(["Bash:npm"]))._tag,
    ).toBe("ask");
  });

  it("accepts edits but still asks about commands in acceptEdits", () => {
    expect(verdictFor("acceptEdits", call("Edit", "edit"), [], none)._tag).toBe("allow");
    expect(verdictFor("acceptEdits", call("delete", "delete"), [], none)._tag).toBe("allow");
    expect(verdictFor("acceptEdits", call("Bash", "execute"), [], none)._tag).toBe("ask");
    expect(verdictFor("acceptEdits", call("mcp__github__create_issue", "edit"), [], none)._tag).toBe("ask");
  });

  it("allows everything with full access", () => {
    expect(verdictFor("fullAccess", call("Bash", "execute"), [], none)._tag).toBe("allow");
  });
});

describe("grants and outcomes", () => {
  it("grants commands by their program and other tools by name", () => {
    expect(grantKey("Bash", "execute", "  npm run test -- --watch")).toBe("Bash:npm");
    expect(grantKey("Edit", "edit", undefined)).toBe("Edit");
    expect(mcpServerOf("mcp__my_server__tool")).toBe("my_server");
    expect(mcpServerOf("Bash")).toBeUndefined();
  });

  it("picks a one-time option before an always one, and cancels without either", () => {
    const options = [
      { optionId: "a", name: "Always", kind: "allow_always" },
      { optionId: "o", name: "Once", kind: "allow_once" },
      { optionId: "r", name: "Reject", kind: "reject_once" },
    ];
    expect(outcomeFor(options, true)).toEqual({ outcome: "selected", optionId: "o" });
    expect(outcomeFor(options, false)).toEqual({ outcome: "selected", optionId: "r" });
    expect(outcomeFor(options.slice(0, 1), true)).toEqual({ outcome: "selected", optionId: "a" });
    expect(outcomeFor(options.slice(0, 2), false)).toEqual({ outcome: "cancelled" });
  });

  it("passes Cerium's MCP servers in ACP's shape", () => {
    expect(
      toAcpMcpServer("cerium", {
        type: "http",
        url: "http://127.0.0.1:9/mcp",
        headers: { Authorization: "Bearer t" },
      }),
    ).toEqual({
      type: "http",
      name: "cerium",
      url: "http://127.0.0.1:9/mcp",
      headers: [{ name: "Authorization", value: "Bearer t" }],
    });
    expect(
      toAcpMcpServer("local", { type: "stdio", command: "node", args: ["s.js"], env: { A: "1" } }),
    ).toEqual({
      name: "local",
      command: "node",
      args: ["s.js"],
      env: [{ name: "A", value: "1" }],
    });
  });
});
