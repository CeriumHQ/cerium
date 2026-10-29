import { describe, expect, it } from "@effect/vitest";

import { appendTomlTable, hasTable, setTomlKey, TomlEditError, tomlValue } from "../src/toml.ts";

const server = ["mcp_servers", "pencil"];

describe("setTomlKey", () => {
  it("adds a table at the end of a file that lacks it", () => {
    expect(setTomlKey('# mine\nmodel = "o3"\n', server, "enabled", false)).toBe(
      '# mine\nmodel = "o3"\n\n[mcp_servers.pencil]\nenabled = false\n',
    );
    expect(setTomlKey("", server, "enabled", false)).toBe("[mcp_servers.pencil]\nenabled = false\n");
  });

  it("replaces a key in place, keeping comments around it and after it", () => {
    const text = "# top\n[mcp_servers.pencil]\n# why\nenabled = false # keep off\nother = 1\n";
    expect(setTomlKey(text, server, "enabled", true)).toBe(
      "# top\n[mcp_servers.pencil]\n# why\nenabled = true # keep off\nother = 1\n",
    );
  });

  it("adds a key after the table's last one, before the next table", () => {
    const text = '[mcp_servers.pencil]\ncommand = "x"\n\n[other]\na = 1\n';
    expect(setTomlKey(text, server, "disabled_tools", ["a", "b"])).toBe(
      '[mcp_servers.pencil]\ncommand = "x"\ndisabled_tools = ["a", "b"]\n\n[other]\na = 1\n',
    );
  });

  it("replaces a value that spans lines", () => {
    const text = '[mcp_servers.pencil]\ndisabled_tools = [\n  "a",\n  "b", # two\n]\nenabled = true\n';
    expect(setTomlKey(text, server, "disabled_tools", ["c"])).toBe(
      '[mcp_servers.pencil]\ndisabled_tools = ["c"]\nenabled = true\n',
    );
  });

  it("removes a key, and the table once it holds none", () => {
    const text = "[a]\nx = 1\n\n[mcp_servers.pencil]\nenabled = false\n\n[b]\ny = 2\n";
    expect(setTomlKey(text, server, "enabled", undefined)).toBe("[a]\nx = 1\n\n[b]\ny = 2\n");
    const kept = '[mcp_servers.pencil]\nenabled = false\ncommand = "x"\n';
    expect(setTomlKey(kept, server, "enabled", undefined)).toBe('[mcp_servers.pencil]\ncommand = "x"\n');
  });

  it("matches quoted names and leaves subtables alone", () => {
    const text = '[mcp_servers."my server"]\ncommand = "x"\n\n[mcp_servers."my server".env]\nK = "v"\n';
    expect(setTomlKey(text, ["mcp_servers", "my server"], "enabled", false)).toBe(
      '[mcp_servers."my server"]\ncommand = "x"\nenabled = false\n\n[mcp_servers."my server".env]\nK = "v"\n',
    );
  });

  it("keeps Windows line endings", () => {
    expect(setTomlKey("[mcp_servers.pencil]\r\nenabled = false\r\n", server, "enabled", true)).toBe(
      "[mcp_servers.pencil]\r\nenabled = true\r\n",
    );
  });

  it("refuses a table written inline or by dotted keys", () => {
    expect(() => setTomlKey('[mcp_servers]\npencil = { command = "x" }\n', server, "enabled", false)).toThrow(
      TomlEditError,
    );
    expect(() => setTomlKey("mcp_servers.pencil.enabled = true\n", server, "enabled", false)).toThrow(
      TomlEditError,
    );
  });

  it("isn't fooled by a # or = inside a string", () => {
    const text = '[mcp_servers.pencil]\nurl = "http://x/#a=b"\nenabled = false\n';
    expect(setTomlKey(text, server, "url", "http://y")).toBe(
      '[mcp_servers.pencil]\nurl = "http://y"\nenabled = false\n',
    );
  });
});

describe("appendTomlTable", () => {
  it("adds a server with its secrets blank", () => {
    expect(
      appendTomlTable("# mine\n", ["mcp_servers", "gh"], {
        command: "npx",
        args: ["-y", "gh"],
        env: { TOKEN: "" },
      }),
    ).toBe('# mine\n\n[mcp_servers.gh]\ncommand = "npx"\nargs = ["-y", "gh"]\nenv = { TOKEN = "" }\n');
  });

  it("knows which tables a file has", () => {
    expect(hasTable('[mcp_servers.gh.env]\nA = ""\n', ["mcp_servers", "gh"])).toBe(true);
    expect(hasTable("[mcp_servers.ghost]\n", ["mcp_servers", "gh"])).toBe(false);
  });

  it("spells values as TOML", () => {
    expect(tomlValue({ "a b": 'say "hi"' })).toBe('{ "a b" = "say \\"hi\\"" }');
  });
});
