import { describe, expect, it } from "@effect/vitest";

import {
  grantsFor,
  mcpNamespace,
  permissionSummary,
  replyFor,
  sessionRules,
  toMcpServer,
  toolNamer,
  type Rule,
} from "../src/policy.ts";

/** OpenCode's evaluation: the last rule whose action and resource globs match wins; none asks. */
const evaluate = (rules: ReadonlyArray<Rule>, action: string, resource = "*") => {
  const glob = (pattern: string) =>
    new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`, "s");
  return (
    rules.findLast((rule) => glob(rule.action).test(action) && glob(rule.resource).test(resource))?.effect ??
    "ask"
  );
};

describe("sessionRules", () => {
  it("lets readOnly read and search but nothing else", () => {
    const rules = sessionRules("readOnly");
    for (const action of ["read", "glob", "grep", "webfetch", "websearch", "skill"]) {
      expect(evaluate(rules, action)).toBe("allow");
    }
    for (const action of ["edit", "shell", "execute", "external_directory", "github_create_issue"]) {
      expect(evaluate(rules, action)).toBe("deny");
    }
  });

  it("asks before env files in every mode that reads, but not before their examples", () => {
    for (const access of ["readOnly", "ask", "acceptEdits", "auto"] as const) {
      const rules = sessionRules(access);
      expect(evaluate(rules, "read", "config/.env")).toBe("ask");
      expect(evaluate(rules, "read", ".env.local")).toBe("ask");
      expect(evaluate(rules, "read", ".env.example")).toBe("allow");
      expect(evaluate(rules, "read", "src/index.ts")).toBe("allow");
    }
  });

  it("asks before edits and commands in ask and auto, and only before commands in acceptEdits", () => {
    for (const access of ["ask", "auto"] as const) {
      expect(evaluate(sessionRules(access), "edit", "a.ts")).toBe("ask");
      expect(evaluate(sessionRules(access), "shell", "ls")).toBe("ask");
    }
    expect(evaluate(sessionRules("acceptEdits"), "edit", "a.ts")).toBe("allow");
    expect(evaluate(sessionRules("acceptEdits"), "shell", "ls")).toBe("ask");
    expect(evaluate(sessionRules("acceptEdits"), "external_directory", "C:/elsewhere/*")).toBe("ask");
  });

  it("asks nothing in fullAccess", () => {
    for (const action of ["edit", "shell", "external_directory", "execute"]) {
      expect(evaluate(sessionRules("fullAccess"), action)).toBe("allow");
    }
  });

  it("withholds OpenCode's subagents and questions in every mode", () => {
    for (const access of ["readOnly", "ask", "acceptEdits", "auto", "fullAccess"] as const) {
      expect(evaluate(sessionRules(access), "subagent")).toBe("deny");
      expect(evaluate(sessionRules(access), "question")).toBe("deny");
    }
  });

  it("trusts Cerium's servers and leaves excluded ones out", () => {
    const rules = sessionRules("readOnly", ["cerium"], ["github", "my.server"]);
    expect(evaluate(rules, "cerium_spawn_agent")).toBe("allow");
    expect(evaluate(sessionRules("fullAccess", [], ["github"]), "github_create_issue")).toBe("deny");
    expect(evaluate(rules, "my_server_tool")).toBe("deny");
  });
});

describe("grantsFor", () => {
  it("allows what the request offered to save, else what it named", () => {
    expect(grantsFor({ action: "shell", resources: ["git status --short"], save: ["git status *"] })).toEqual(
      [{ action: "shell", resource: "git status *", effect: "allow" }],
    );
    expect(grantsFor({ action: "edit", resources: ["a.ts"] })).toEqual([
      { action: "edit", resource: "a.ts", effect: "allow" },
    ]);
  });

  it("outranks the mode's ask once appended", () => {
    const rules = [
      ...sessionRules("ask"),
      ...grantsFor({ action: "shell", resources: ["ls"], save: ["ls *"] }),
    ];
    expect(evaluate(rules, "shell", "ls -la")).toBe("allow");
    expect(evaluate(rules, "shell", "rm -rf x")).toBe("ask");
  });
});

describe("replyFor", () => {
  it("answers once whatever the scope, and passes a denial's message on", () => {
    expect(replyFor({ decision: "allow", scope: "session" })).toEqual({ decision: "once" });
    expect(replyFor({ decision: "allow", scope: "once" })).toEqual({ decision: "once" });
    expect(replyFor({ decision: "deny", scope: "once", message: "Use the tests" })).toEqual({
      decision: "reject",
      message: "Use the tests",
    });
    expect(replyFor({ decision: "deny", scope: "once" })).toEqual({ decision: "reject" });
  });
});

describe("toMcpServer", () => {
  it("configures servers for direct calls, outside Code Mode", () => {
    expect(
      toMcpServer({ type: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer t" } }),
    ).toEqual({
      type: "remote",
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer t" },
      oauth: false,
      codemode: false,
    });
    expect(toMcpServer({ type: "stdio", command: "node", args: ["echo.ts"], env: { A: "1" } })).toEqual({
      type: "local",
      command: ["node", "echo.ts"],
      environment: { A: "1" },
      codemode: false,
    });
  });
});

describe("toolNamer", () => {
  it("names MCP tools by server, the longest server name first", () => {
    const name = toolNamer(["cerium", "my", "my_server", "my.dotted"]);
    expect(name("cerium_spawn_agent")).toBe("mcp__cerium__spawn_agent");
    expect(name("my_server_tool")).toBe("mcp__my_server__tool");
    expect(name("my_dotted_go")).toBe("mcp__my.dotted__go");
    expect(name("read")).toBe("read");
    expect(name("cerium_")).toBe("cerium_");
    expect(mcpNamespace("a b/c")).toBe("a_b_c");
  });
});

describe("permissionSummary", () => {
  it("says what the request wants in a line", () => {
    expect(permissionSummary({ action: "shell", resources: ["npm test"] })).toBe("Run npm test");
    expect(permissionSummary({ action: "edit", resources: ["a.ts", "b.ts"] })).toBe("Edit a.ts, b.ts");
    expect(permissionSummary({ action: "execute", resources: ["*"] })).toBe("Use execute");
    expect(permissionSummary({ action: "github_create_issue", resources: ["repo"] })).toBe(
      "Use github_create_issue on repo",
    );
    expect(permissionSummary({ action: "edit", resources: ["a.ts"], message: "Apply the fix" })).toBe(
      "Apply the fix",
    );
  });
});
