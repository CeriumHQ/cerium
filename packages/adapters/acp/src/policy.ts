import type { McpServerSpec } from "@cerium/harness";
import type { AccessMode } from "@cerium/protocol";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { PermissionOption } from "./schema.ts";

// How Cerium's access modes answer an ACP agent's permission requests. The agent asks for what its
// own settings make it ask for; the session's access mode decides which of those Cerium answers
// itself and which reach the user. ACP's tool kinds say what a call does.

/** Kinds of calls that only read the workspace or the web. */
const READING = new Set(["read", "search", "think", "fetch"]);
/** Kinds of calls that change files in the workspace. */
const EDITING = new Set(["edit", "delete", "move"]);

export type Verdict =
  | { readonly _tag: "allow" }
  | { readonly _tag: "deny"; readonly message: string }
  | { readonly _tag: "ask" };

/** A permission request as the policy reads it. */
export interface PolicyCall {
  /** ACP's kind for the call. */
  readonly kind?: string;
  /** Cerium's name for it: `mcp__server__tool` for an MCP server's tool. */
  readonly toolName: string;
  /** The agent says the call only reads (an agent extension; ACP's kind says so otherwise). */
  readonly readOnly?: boolean;
  /** What a "for this session" allow of it covers (`grantKey`). */
  readonly grant: string;
}

/** The MCP server a tool named `mcp__server__tool` belongs to. */
export const mcpServerOf = (toolName: string): string | undefined => /^mcp__(.+?)__./.exec(toolName)?.[1];

const READ_ONLY_REFUSAL =
  "This session is read-only: it can read and search, but not change files, run commands or use other tools.";

/**
 * What Cerium answers a permission request with, before the user sees it:
 * - the trusted servers' tools (Cerium's own bus) run in every mode;
 * - `readOnly` allows reading only and refuses the rest;
 * - `ask` and `auto` ask the user (the agent's own auto mode already decided what it asks about);
 * - `acceptEdits` allows workspace edits and asks about the rest;
 * - `fullAccess` allows everything.
 * Calls the user allowed for the session (`granted`) run without asking again.
 */
export const verdictFor = (
  access: AccessMode,
  call: PolicyCall,
  trusted: ReadonlyArray<string>,
  granted: ReadonlySet<string>,
): Verdict => {
  const server = mcpServerOf(call.toolName);
  if (server !== undefined && trusted.includes(server)) return { _tag: "allow" };
  const reads = call.readOnly === true || (server === undefined && READING.has(call.kind ?? ""));
  switch (access) {
    case "readOnly":
      return reads ? { _tag: "allow" } : { _tag: "deny", message: READ_ONLY_REFUSAL };
    case "fullAccess":
      return { _tag: "allow" };
    case "acceptEdits":
      if (server === undefined && EDITING.has(call.kind ?? "")) return { _tag: "allow" };
      break;
    case "ask":
    case "auto":
      break;
  }
  if (reads || granted.has(call.grant)) return { _tag: "allow" };
  return { _tag: "ask" };
};

/**
 * What a "for this session" allow covers: an MCP tool, a command by its program, or any other tool
 * by name. Kept by the adapter: an agent's own "always" options may write to the user's settings.
 */
export const grantKey = (toolName: string, kind: string | undefined, command: string | undefined): string => {
  if (kind === "execute" && command !== undefined) {
    const program = command.trim().split(/\s+/, 1)[0] ?? "";
    return `${toolName}:${program}`;
  }
  return toolName;
};

export type PermissionOutcome =
  | { readonly outcome: "selected"; readonly optionId: string }
  | { readonly outcome: "cancelled" };

/**
 * The option that allows or refuses a call once. An "always" option only where the agent offers no
 * one-time one, since it may last beyond the session; with neither, the request is cancelled.
 */
export const outcomeFor = (options: ReadonlyArray<PermissionOption>, allow: boolean): PermissionOutcome => {
  const kinds = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of kinds) {
    const option = options.find((each) => each.kind === kind);
    if (option !== undefined) return { outcome: "selected", optionId: option.optionId };
  }
  return { outcome: "cancelled" };
};

const pairs = (record: Readonly<Record<string, string>> | undefined) =>
  Object.entries(record ?? {}).map(([name, value]) => ({ name, value }));

/**
 * The stdio MCP server that carries an agent to an HTTP one (`mcp-bridge.ts`): bundled beside the
 * packaged app's backend, its TypeScript source while developing.
 */
const bridgeScript = () => {
  const bundled = join(import.meta.dirname, "mcp-bridge.mjs");
  return existsSync(bundled) ? bundled : join(import.meta.dirname, "mcp-bridge.ts");
};

/**
 * ACP's MCP server entry for one of Cerium's: lists of name and value where Cerium keeps records. An
 * agent that starts only stdio servers (`httpMcp` false: all ACP requires of one) reaches an HTTP
 * server through the bridge, run by the Node running Cerium (Electron's own, as Node, once packaged).
 */
export const toAcpMcpServer = (name: string, spec: McpServerSpec, httpMcp: boolean) => {
  if (spec.type === "stdio") {
    return { name, command: spec.command, args: [...spec.args], env: pairs(spec.env) };
  }
  if (httpMcp) return { type: "http", name, url: spec.url, headers: pairs(spec.headers) };
  return {
    name,
    command: process.execPath,
    args: [bridgeScript(), spec.url],
    env: pairs({ ELECTRON_RUN_AS_NODE: "1", CERIUM_MCP_HEADERS: JSON.stringify(spec.headers ?? {}) }),
  };
};
