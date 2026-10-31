import type { McpServerSpec } from "@cerium/harness";
import type { AccessMode, ReasoningEffort } from "@cerium/protocol";
import { stringify } from "yaml";

// What one Cerium session gives Antigravity, without touching the user's own configuration:
// - a custom agent, `~/.gemini/config/agents/<name>.md`, selected with `--agent`: hidden from the
//   user's lists, the session's main agent, carrying Cerium's instructions as its prompt, inheriting
//   the user's MCP servers only when asked (`inheritMcp`), and naming Cerium's plugin;
// - Cerium's plugin, a folder of Cerium's own: `mcp_config.json` with Cerium's MCP servers, and
//   `hooks.json` with the `PreToolUse` hook that asks Cerium about every tool call (hook.ts).
// The plugin's layout passes the 1.4.12 binary's own `agy plugin validate --strict`; the agent's
// frontmatter keys are the ones its changelog and binary name. Both are removed when the session ends.

/** The plugin's name, which Antigravity puts before its servers' names (`cerium_<server>`). */
export const PLUGIN_NAME = "cerium";

/** How long the hook may wait for Cerium's answer, which can be the user's: an hour. */
export const HOOK_TIMEOUT_SECONDS = 3600;

/** An injected server as `mcp_config.json` spells it: `serverUrl` for HTTP, `command` for stdio. */
export const toMcpConfig = (spec: McpServerSpec) =>
  spec.type === "http"
    ? { serverUrl: spec.url, ...(spec.headers ? { headers: { ...spec.headers } } : {}) }
    : { command: spec.command, args: [...spec.args], ...(spec.env ? { env: { ...spec.env } } : {}) };

export const pluginManifest = () => ({
  name: PLUGIN_NAME,
  version: "1.0.0",
  description: "Cerium's tools and approvals for one Cerium session. Removed when the session ends.",
});

export const mcpConfig = (servers: Readonly<Record<string, McpServerSpec>>) => ({
  mcpServers: Object.fromEntries(Object.entries(servers).map(([name, spec]) => [name, toMcpConfig(spec)])),
});

/** The hook that sends every tool call to Cerium and answers with Cerium's decision. */
export const hooksConfig = (command: string) => ({
  [PLUGIN_NAME]: {
    enabled: true,
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }] }],
  },
});

/** The session's custom agent: frontmatter, then Cerium's instructions as its H1-delimited prompt. */
export const agentFile = (options: {
  readonly name: string;
  readonly pluginDirectory: string;
  readonly includeUserMcpServers: boolean;
  readonly instructions?: string | undefined;
}) => {
  const frontmatter = {
    name: options.name,
    description: "Cerium's agent for one Cerium session. Removed when the session ends.",
    mainAgent: true,
    subagent: false,
    hidden: true,
    inheritCustomizations: true,
    inheritMcp: options.includeUserMcpServers,
    plugins: [options.pluginDirectory],
  };
  const instructions = options.instructions?.trim() || "Work on what the user asks.";
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n# Cerium\n\n${instructions}\n`;
};

/** Antigravity's `--mode` for an access mode; the hook decides the rest. */
export const modeFor = (access: AccessMode): string | undefined =>
  access === "acceptEdits" ? "accept-edits" : undefined;

/** One turn's command line: streamed in and out, on Cerium's agent, continuing the conversation. */
export const runArgs = (options: {
  readonly agent: string;
  readonly conversation?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: ReasoningEffort | undefined;
  readonly access: AccessMode;
}): ReadonlyArray<string> => {
  const mode = modeFor(options.access);
  return [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--agent",
    options.agent,
    ...(options.conversation ? ["--conversation", options.conversation] : []),
    ...(options.model ? ["--model", options.model] : []),
    ...(options.effort ? ["--effort", antigravityEffort(options.effort)] : []),
    ...(mode ? ["--mode", mode] : []),
  ];
};

/** Cerium's efforts as `--effort` takes them (`low|medium|high|xhigh|max`). */
export const antigravityEffort = (effort: ReasoningEffort) => (effort === "minimal" ? "low" : effort);

/** The environment of every run: the CLI must not update itself under a session. */
export const RUN_ENV = { AGY_CLI_DISABLE_AUTO_UPDATE: "true" } as const;

/** One turn's message on stdin, as `--input-format stream-json` reads it. */
export const userLine = (text: string) =>
  `${JSON.stringify({ event: "user", message: { content: text } })}\n`;

/** POSIX shell quoting. */
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * The hook's command: Node running the hook script. Hooks run with a sanitized environment, so
 * everything the script needs is in its own folder; under Electron, Node is Cerium's own binary with
 * `ELECTRON_RUN_AS_NODE`.
 */
export const hookCommand = (
  script: string,
  runtime = process.execPath,
  electron = process.versions["electron"] !== undefined,
) =>
  process.platform === "win32"
    ? `${electron ? "set ELECTRON_RUN_AS_NODE=1&& " : ""}"${runtime}" "${script}"`
    : `${electron ? "ELECTRON_RUN_AS_NODE=1 " : ""}${quote(runtime)} ${quote(script)}`;

/**
 * The hook script, written into the plugin folder. It forwards the hook's input to Cerium's bridge and
 * prints the decision. Any failure denies: a tool never runs without Cerium's word.
 */
export const HOOK_SCRIPT = `// Cerium's PreToolUse hook for Antigravity: asks the Cerium session that wrote it whether a tool may run.
import { readFileSync } from "node:fs";
import { request } from "node:http";

const deny = (reason) => {
  process.stdout.write(JSON.stringify({ decision: "deny", reason }));
  process.exit(0);
};
let config;
try {
  config = JSON.parse(readFileSync(new URL("./bridge.json", import.meta.url), "utf8"));
} catch {
  deny("Cerium's session for this run has ended.");
}
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const body = Buffer.concat(chunks);
  const call = request(
    { host: "127.0.0.1", port: config.port, path: "/hook", method: "POST", headers: { "content-type": "application/json", "x-cerium-token": config.token } },
    (response) => {
      const answer = [];
      response.on("data", (chunk) => answer.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) return deny("Cerium refused the request.");
        process.stdout.write(Buffer.concat(answer).toString("utf8"));
        process.exit(0);
      });
    },
  );
  call.on("error", () => deny("Cerium is not reachable."));
  call.end(body);
});
`;
