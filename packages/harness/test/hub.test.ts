import { describe, expect, it } from "@effect/vitest";

import {
  editJsonc,
  editJsoncPruned,
  fromMcpJson,
  portable,
  secretsOf,
  skillFrontMatter,
  toMcpJson,
  unfilled,
} from "../src/hub.ts";

describe("secretsOf", () => {
  it("names each value and says whether it's set, never what it is", () => {
    expect(secretsOf({ TOKEN: "abc", EMPTY: "" })).toEqual([
      { name: "TOKEN", set: true },
      { name: "EMPTY", set: false },
    ]);
    expect(secretsOf(["REDACTED"])).toEqual([{ name: "REDACTED", set: true }]);
    expect(secretsOf(undefined)).toEqual([]);
  });
});

describe("the mcpServers format", () => {
  it("reads stdio and http servers, keeping only the names of their secrets", () => {
    const stdio = fromMcpJson(
      "gh",
      { command: "npx", args: ["-y", "gh"], env: { TOKEN: "secret" } },
      "user",
      "f",
    );
    expect(stdio).toEqual({
      name: "gh",
      scope: "user",
      transport: "stdio",
      command: "npx",
      args: ["-y", "gh"],
      env: [{ name: "TOKEN", set: true }],
      headers: [],
      enabled: true,
      disabledTools: [],
      file: "f",
    });
    expect(JSON.stringify(stdio)).not.toContain("secret");
    expect(fromMcpJson("web", { url: "https://x" }, "project", undefined)?.transport).toBe("http");
    expect(fromMcpJson("old", { type: "sse", url: "https://x" }, "project", undefined)?.transport).toBe(
      "sse",
    );
    expect(fromMcpJson("broken", { args: [] }, "user", undefined)).toBeUndefined();
  });

  it("copies a server's shape with its secrets blank", () => {
    const server = fromMcpJson(
      "web",
      { type: "http", url: "https://x", headers: { Authorization: "Bearer t" }, env: { UNUSED: "" } },
      "user",
      undefined,
    )!;
    const shape = portable(server);
    expect(toMcpJson(shape)).toEqual({ type: "http", url: "https://x", headers: { Authorization: "" } });
    expect(unfilled(shape)).toEqual(["Authorization"]);
  });
});

describe("editJsonc", () => {
  it("changes one value and keeps comments and indentation", () => {
    const text = '{\n    // mine\n    "a": 1\n}\n';
    expect(editJsonc(text, ["b"], true)).toBe('{\n    // mine\n    "a": 1,\n    "b": true\n}\n');
    expect(editJsonc("", ["a", "b"], 1)).toBe('{\n  "a": {\n    "b": 1\n  }\n}\n');
  });

  it("drops a value left empty, and the objects it emptied", () => {
    const text = '{\n  "keep": 1,\n  "permissions": {\n    "deny": ["x"]\n  }\n}\n';
    expect(editJsoncPruned(text, ["permissions", "deny"], [])).toBe('{\n  "keep": 1\n}\n');
  });
});

describe("skillFrontMatter", () => {
  it("reads the name and description, quoted or folded", () => {
    expect(skillFrontMatter('---\nname: review\ndescription: "Reviews code"\n---\nbody')).toEqual({
      name: "review",
      description: "Reviews code",
    });
    expect(skillFrontMatter("---\r\nname: x\r\ndescription: >\r\n  Two\r\n  lines\r\n---\r\n")).toEqual({
      name: "x",
      description: "Two lines",
    });
    expect(skillFrontMatter("no front matter")).toEqual({});
  });

  it("keeps a skill's name free of its YAML comment", () => {
    expect(skillFrontMatter('---\nname: review # comment\ndescription: "Reviews \\"code\\""\n---\n')).toEqual(
      {
        name: "review",
        description: 'Reviews "code"',
      },
    );
  });

  it("ignores malformed or non-mapping front matter and non-string fields", () => {
    expect(skillFrontMatter("---\nname: [unterminated\n---\n")).toEqual({});
    expect(skillFrontMatter("---\n- list\n---\n")).toEqual({});
    expect(skillFrontMatter("---\nname: 42\ndescription: false\n---\n")).toEqual({});
    expect(skillFrontMatter("---\nname: a\nname: b\n---\n")).toEqual({});
  });
});
