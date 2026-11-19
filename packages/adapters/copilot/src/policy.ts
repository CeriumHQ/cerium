import type { McpServerSpec, SessionOptions } from "@cerium/harness";
import { Effect } from "effect";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { failure, record, string, type CopilotHost } from "./rpc.ts";

const nativeAgentTools = ["task", "read_agent", "write_agent", "list_agents", "send_inbox", "context_board"];
const readTools = ["builtin:view", "builtin:glob", "builtin:grep"];

export const mcpToolName = (server: string, tool: string) => `mcp__${server}__${tool}`;

const toMcpServer = (spec: McpServerSpec) => ({
  ...spec,
  tools: ["*"],
  deferTools: "never",
});

/** Discovery returns server names and status without launching servers or reading their credentials. */
const readServers = (value: unknown) => {
  const servers = record(value)?.["servers"];
  if (!Array.isArray(servers)) return undefined;
  const rows: Array<{ name: string; enabled: boolean }> = [];
  for (const value of servers) {
    const server = record(value);
    const name = string(server?.["name"]);
    const enabled = server?.["enabled"];
    if (!name || typeof enabled !== "boolean") return undefined;
    rows.push({ name, enabled });
  }
  return rows;
};

export const sessionPolicy = Effect.fn("CopilotAdapter.sessionPolicy")(function* (
  host: CopilotHost,
  options: SessionOptions,
) {
  const readOnly = options.access === "readOnly";
  const includeUserMcp = !readOnly && options.includeUserMcpServers;
  const entries = Object.entries(options.mcpServers);
  const trusted = new Set(options.trustedMcpServers);
  const injected = new Map(readOnly ? entries.filter(([name]) => trusted.has(name)) : entries);
  const disabledServers: Array<string> = [];
  if (!includeUserMcp) {
    // The CLI still loads personal MCP configuration when enableConfigDiscovery is false.
    const discovered = readServers(yield* host.request("mcp.discover", { workingDirectory: options.cwd }));
    if (discovered === undefined)
      return yield* failure("GitHub Copilot CLI returned an invalid MCP server list")(undefined);
    disabledServers.push(...discovered.map(({ name }) => name).filter((name) => !injected.has(name)));
  }
  return {
    mcp: {
      servers: Object.fromEntries([...injected].map(([name, spec]) => [name, toMcpServer(spec)])),
      envValueMode: "direct",
      disabledServers,
    },
    tools: {
      excludedTools: [...nativeAgentTools, "ask_user", "run_program"].map((tool) => `builtin:${tool}`),
      ...(readOnly ? { availableTools: [...readTools, "mcp:*"] } : {}),
    },
    enableConfigDiscovery: includeUserMcp,
    verifyMcp: (sessionId: string) =>
      includeUserMcp
        ? Effect.void
        : Effect.gen(function* () {
            const configured = readServers(yield* host.request("session.mcp.listConfigured", { sessionId }));
            if (
              configured === undefined ||
              configured.some(({ name, enabled }) => enabled && !injected.has(name))
            ) {
              return yield* failure("GitHub Copilot CLI could not exclude user-configured MCP servers")(
                undefined,
              );
            }
          }),
  };
});

/** Unknown, managed, and sandbox-escalating operations never receive an automatic grant. */
const canAutoApprove = (request: Record<string, unknown>) =>
  request["managedApprovalRequired"] !== true &&
  request["requestSandboxBypass"] !== true &&
  request["requestSandboxPermissive"] !== true &&
  request["sandboxPathGrant"] === undefined;

const withinWorkspace = (cwd: string, value: unknown) => {
  const path = string(value);
  if (!path) return false;
  const candidate = resolve(cwd, path);
  try {
    // Resolve the existing ancestor for a new file, including symlinks along the way.
    const folder =
      lstatSync(candidate, { throwIfNoEntry: false }) === undefined
        ? realpathSync.native(dirname(candidate))
        : realpathSync.native(candidate);
    const fromRoot = relative(realpathSync.native(cwd), folder);
    return !isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`);
  } catch {
    return false;
  }
};

export const classifyPermission = (options: SessionOptions, data: Record<string, unknown>) => {
  const request = record(data["permissionRequest"]) ?? {};
  const kind = string(request["kind"]) ?? "unknown";
  const server = string(request["serverName"]);
  const wireTool = string(request["toolName"]);
  const prefix = `${server}-`;
  const tool = wireTool?.startsWith(prefix) ? wireTool.slice(prefix.length) : wireTool;
  const rawTarget = request["fullCommandText"] ?? request["fileName"] ?? request["path"] ?? request["url"];
  const trustedMcp =
    kind === "mcp" &&
    server !== undefined &&
    Object.hasOwn(options.mcpServers, server) &&
    options.trustedMcpServers?.includes(server) === true;
  const knownPermission = ["read", "write", "shell", "url", "mcp"].includes(kind);
  const ordinary = canAutoApprove(request);
  const workspaceRead =
    kind === "read" &&
    withinWorkspace(options.cwd, request["path"]) &&
    (request["resolvedPath"] === undefined || withinWorkspace(options.cwd, request["resolvedPath"]));
  const workspaceEdit =
    kind === "write" &&
    withinWorkspace(options.cwd, request["fileName"]) &&
    (request["resolvedPath"] === undefined || withinWorkspace(options.cwd, request["resolvedPath"]));
  const auto =
    ordinary &&
    (trustedMcp ||
      workspaceRead ||
      (options.access === "acceptEdits" && workspaceEdit) ||
      (options.access === "fullAccess" && knownPermission));

  // Keep session grants in Cerium's session only. Copilot's write approval covers all writes and
  // its shell approval covers command prefixes, both wider than the request the user saw.
  const { toolCallId: _toolCallId, ...operation } = request;
  return {
    request,
    operation:
      ordinary && knownPermission && (kind === "mcp" || request["canOfferSessionApproval"] === true)
        ? operation
        : undefined,
    decision: auto
      ? ("allow" as const)
      : options.access === "readOnly" || !knownPermission
        ? ("deny" as const)
        : undefined,
    toolName: kind === "mcp" && server && tool ? mcpToolName(server, tool) : `copilot.${kind}`,
    summary:
      string(request["requestSandboxBypassReason"]) ??
      (kind === "mcp" && server && tool
        ? `Use ${server} / ${tool}`
        : [
            kind === "shell" ? "Run" : kind === "write" ? "Edit" : kind === "read" ? "Read" : "Allow",
            string(rawTarget),
          ]
            .filter((part) => part !== undefined)
            .join(" ")),
  };
};
