import type { McpServerSpec, PermissionDecision } from "@cerium/harness";
import type { AccessMode } from "@cerium/protocol";

// How Cerium's access modes, MCP servers and approvals map onto OpenCode's. A session's permission rules
// are appended to its agent's, and the last matching rule wins; a rule that denies a whole action hides
// its tool from the model. Cerium's rules go on the session, never into the user's configuration.

export interface Rule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
}

const rule = (action: string, effect: Rule["effect"], resource = "*"): Rule => ({ action, resource, effect });

/** Built-in actions that only read the workspace or the web. */
export const READ_ACTIONS = ["read", "glob", "grep", "webfetch", "websearch", "skill"] as const;

/** OpenCode asks before an agent reads env files; Cerium keeps that wherever it lets reads through. */
const ENV_FILES: ReadonlyArray<Rule> = [
  rule("read", "ask", "*.env"),
  rule("read", "ask", "*.env.*"),
  rule("read", "allow", "*.env.example"),
];

/**
 * Tools only Cerium offers: subagents run through Cerium's bus, and agents ask the user through its
 * `ask_user`, so OpenCode's own `subagent` and `question` tools are withheld in every mode.
 */
export const WITHHELD_ACTIONS = ["subagent", "question"] as const;

/** OpenCode's action name for an MCP server's tools: its name with unsupported characters as `_`. */
export const mcpNamespace = (server: string) => server.replace(/[^a-zA-Z0-9_-]/g, "_");

/**
 * The rules for an access mode, then Cerium's trusted servers, then the user's MCP servers left out of
 * this session, then the withheld tools.
 * - `readOnly`: everything denied but reading and the web (Code Mode's `execute` too).
 * - `ask` and `auto`: everything asks but reading. OpenCode has no reviewer model, so `auto` asks the
 *   user as `ask` does.
 * - `acceptEdits`: as `ask`, with edits inside the workspace allowed.
 * - `fullAccess`: nothing asks.
 */
export const sessionRules = (
  access: AccessMode,
  trustedServers: ReadonlyArray<string> = [],
  excludedServers: ReadonlyArray<string> = [],
): ReadonlyArray<Rule> => {
  const reads = READ_ACTIONS.map((action) => rule(action, "allow"));
  const base: ReadonlyArray<Rule> = (() => {
    switch (access) {
      case "readOnly":
        return [rule("*", "deny"), ...reads, ...ENV_FILES];
      case "ask":
      case "auto":
        return [rule("*", "ask"), ...reads, ...ENV_FILES];
      case "acceptEdits":
        return [rule("*", "ask"), ...reads, ...ENV_FILES, rule("edit", "allow")];
      case "fullAccess":
        return [rule("*", "allow")];
    }
  })();
  return [
    ...base,
    ...trustedServers.map((server) => rule(`${mcpNamespace(server)}_*`, "allow")),
    ...excludedServers.map((server) => rule(`${mcpNamespace(server)}_*`, "deny")),
    ...WITHHELD_ACTIONS.map((action) => rule(action, "deny")),
  ];
};

/**
 * Rules that let what a request asked about through for the rest of the session: its `save` patterns
 * (`git status *` for a command), or its resources when it gives none. OpenCode's own "always" would
 * save them for the user's project instead.
 */
export const grantsFor = (request: {
  readonly action: string;
  readonly resources: ReadonlyArray<string>;
  readonly save?: ReadonlyArray<string> | undefined;
}): ReadonlyArray<Rule> =>
  (request.save !== undefined && request.save.length > 0 ? request.save : request.resources).map((resource) =>
    rule(request.action, "allow", resource),
  );

/** A decision as OpenCode's reply. A session-wide allow is a `once` plus session rules (`grantsFor`). */
export const replyFor = (decision: PermissionDecision) =>
  decision.decision === "deny"
    ? ({ decision: "reject", ...(decision.message ? { message: decision.message } : {}) } as const)
    : ({ decision: "once" } as const);

/** An injected server as OpenCode configures it. Its tools are called directly, not through Code Mode. */
export const toMcpServer = (spec: McpServerSpec) =>
  spec.type === "http"
    ? {
        type: "remote" as const,
        url: spec.url,
        ...(spec.headers ? { headers: { ...spec.headers } } : {}),
        oauth: false as const,
        codemode: false,
      }
    : {
        type: "local" as const,
        command: [spec.command, ...spec.args],
        ...(spec.env ? { environment: { ...spec.env } } : {}),
        codemode: false,
      };

/**
 * Tool names as every adapter reports them: built-ins keep OpenCode's names, and an MCP tool, which
 * OpenCode names `<server>_<tool>`, becomes `mcp__<server>__<tool>` for the servers this session knows.
 */
export const toolNamer = (servers: ReadonlyArray<string>) => {
  // Longest first, so `my_server` wins over `my` for `my_server_tool`.
  const prefixes = servers
    .map((server) => ({ server, prefix: `${mcpNamespace(server)}_` }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  return (name: string): string => {
    const match = prefixes.find(({ prefix }) => name.startsWith(prefix) && name.length > prefix.length);
    return match === undefined ? name : `mcp__${match.server}__${name.slice(match.prefix.length)}`;
  };
};

/** One line saying what a permission request wants to do. */
export const permissionSummary = (request: {
  readonly action: string;
  readonly resources: ReadonlyArray<string>;
  readonly message?: string | undefined;
}): string => {
  const subject = request.resources.filter((resource) => resource !== "*").join(", ");
  const verb: Record<string, string> = {
    edit: "Edit",
    shell: "Run",
    read: "Read",
    external_directory: "Work outside the project in",
    webfetch: "Fetch",
    websearch: "Search the web for",
    skill: "Use the skill",
    glob: "Find files matching",
    grep: "Search for",
  };
  const said = request.message?.trim();
  if (said) return said;
  const known = verb[request.action];
  if (known !== undefined) return subject === "" ? known : `${known} ${subject}`;
  return subject === "" ? `Use ${request.action}` : `Use ${request.action} on ${subject}`;
};
