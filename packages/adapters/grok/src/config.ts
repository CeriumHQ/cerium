import type { McpServer } from "@cerium/adapter-acp";
import { Effect } from "effect";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

// The MCP servers the user configured for Grok Build, for sessions that keep them
// (`includeUserMcpServers`). Over ACP the client loads them, as Grok's own headless client does: the
// agent itself adds only managed and plugin servers. Only the user's own `config.toml` is read. A
// project's `.grok/config.toml` loads in Grok only once the user trusts the folder, which Cerium can't
// see, so it is left out rather than letting a cloned repository start commands.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Grok's home: `$GROK_HOME`, else `~/.grok`. */
export const grokHome = () => process.env["GROK_HOME"] || join(homedir(), ".grok");

/** `${VAR}` and `$VAR` in a value, from the environment, as Grok expands them. */
const expand = (value: string, env: NodeJS.ProcessEnv) =>
  value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_, braced, bare) => env[braced ?? bare] ?? "",
  );

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : [];

const pairs = (value: unknown, env: NodeJS.ProcessEnv) =>
  isRecord(value)
    ? Object.entries(value).flatMap(([name, each]) =>
        typeof each === "string" ? [{ name, value: expand(each, env) }] : [],
      )
    : [];

/** `[mcp_servers.<name>]` tables as ACP servers. Disabled ones and ones Cerium can't pass are left out. */
export const mcpServersFromConfig = (
  config: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlyArray<McpServer> => {
  const servers = isRecord(config) ? config["mcp_servers"] : undefined;
  if (!isRecord(servers)) return [];
  return Object.entries(servers).flatMap(([name, entry]): ReadonlyArray<McpServer> => {
    if (!isRecord(entry) || entry["enabled"] === false) return [];
    const url = typeof entry["url"] === "string" ? expand(entry["url"], env) : undefined;
    if (url !== undefined) {
      const headers = pairs(entry["headers"] ?? entry["http_headers"], env);
      const tokenVariable = entry["bearer_token_env_var"];
      const token = typeof tokenVariable === "string" ? env[tokenVariable] : undefined;
      return [
        {
          type: entry["transport"] === "sse" ? "sse" : "http",
          name,
          url,
          headers: token ? [...headers, { name: "Authorization", value: `Bearer ${token}` }] : headers,
        },
      ];
    }
    if (typeof entry["command"] !== "string") return [];
    return [
      {
        name,
        command: expand(entry["command"], env),
        args: strings(entry["args"]).map((arg) => expand(arg, env)),
        env: pairs(entry["env"], env),
      },
    ];
  });
};

/** The servers in the user's own Grok config; none when it has none or can't be read. */
export const readUserMcpServers = (_cwd: string) =>
  Effect.tryPromise(() => readFile(join(grokHome(), "config.toml"), "utf8")).pipe(
    Effect.map((text) => mcpServersFromConfig(parse(text))),
    Effect.orElseSucceed((): ReadonlyArray<McpServer> => []),
  );
