import type { McpServerSpec, SessionOptions } from "@cerium/harness";
import type { AccessMode, ReasoningEffort } from "@cerium/protocol";

import type { JsonValue } from "./protocol/serde_json/JsonValue.ts";
import type { ApprovalsReviewer } from "./protocol/v2/ApprovalsReviewer.ts";
import type { AskForApproval } from "./protocol/v2/AskForApproval.ts";
import type { SandboxMode } from "./protocol/v2/SandboxMode.ts";
import type { ThreadStartParams } from "./protocol/v2/ThreadStartParams.ts";

// Pure mapping from Cerium's session options onto app-server thread parameters.

export interface AccessPolicy {
  readonly sandbox: SandboxMode;
  readonly approvalPolicy: AskForApproval;
  readonly approvalsReviewer: ApprovalsReviewer;
  /**
   * Codex has no "edits only" policy, so `acceptEdits` runs as `ask` and the adapter approves file
   * changes inside the workspace itself.
   */
  readonly approveWorkspaceEdits: boolean;
}

/**
 * Every mode runs commands in Codex's read-only sandbox, so reading and searching never ask (like
 * Claude's Read/Grep tools), while anything that writes or needs the network has to leave the sandbox:
 * - `readOnly`: leaving the sandbox (and execpolicy prompts) is rejected by Codex without asking. MCP
 *   tool approvals still reach Cerium, so MCP tools stay available as they do for Claude.
 * - `ask`: `on-request` turns every escalation and every file change into an approval request.
 *   (`untrusted` would also ask before each read: on Windows it asked for `Get-Content`.)
 * - `acceptEdits`: as `ask`, with workspace file changes approved by the adapter.
 * An approved command runs outside the sandbox, as it does in Codex itself.
 * - `auto`: Codex's own "Approve for me" preset: commands and edits run in the workspace-write sandbox,
 *   and Codex's auto-reviewer, not the user, approves or refuses each escalation.
 * - `fullAccess`: Codex's own "Full access" preset: no sandbox, and Codex never asks.
 */
export const accessPolicy = (access: AccessMode): AccessPolicy => {
  switch (access) {
    case "readOnly":
      return {
        sandbox: "read-only",
        approvalPolicy: {
          granular: {
            sandbox_approval: false,
            rules: false,
            skill_approval: false,
            request_permissions: false,
            mcp_elicitations: true,
          },
        },
        approvalsReviewer: "user",
        approveWorkspaceEdits: false,
      };
    case "ask":
      return {
        sandbox: "read-only",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        approveWorkspaceEdits: false,
      };
    case "acceptEdits":
      return {
        sandbox: "read-only",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        approveWorkspaceEdits: true,
      };
    case "auto":
      return {
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        approveWorkspaceEdits: true,
      };
    case "fullAccess":
      return {
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        approveWorkspaceEdits: true,
      };
  }
};

/**
 * Turns Codex's native subagents off (architecture §3.1). On 0.162.1 only `agents.enabled=false`
 * removes the `collaboration.*` spawn tools from multi-agent v2 models; the feature flags alone leave
 * them in place. They are still set so a v1 model cannot fall back to its own spawn tools.
 */
const NATIVE_SUBAGENTS_OFF = {
  agents: { enabled: false },
  features: { multi_agent: false, multi_agent_v2: false },
} as const;

const EFFORT_ORDER: ReadonlyArray<ReasoningEffort> = ["minimal", "low", "medium", "high", "xhigh", "max"];

const isCeriumEffort = (effort: string): effort is ReasoningEffort =>
  (EFFORT_ORDER as ReadonlyArray<string>).includes(effort);

/** Codex's effort name in Cerium's vocabulary; efforts Cerium has no name for (`none`, `ultra`) are dropped. */
export const fromCodexEffort = (effort: string | null | undefined): ReasoningEffort | undefined =>
  effort != null && isCeriumEffort(effort) ? effort : undefined;

/** A model's efforts in Cerium's vocabulary, lowest first. */
export const ceriumEfforts = (supported: ReadonlyArray<string>): ReadonlyArray<ReasoningEffort> =>
  EFFORT_ORDER.filter((effort) => supported.includes(effort));

/**
 * Picks the effort to send for a model. The names are shared, so a supported effort passes through;
 * otherwise the nearest supported one above it is used (`minimal` → `low` on models without
 * `minimal`), or the highest below it (`max` → `xhigh`). Unknown models get the effort unchanged.
 */
export const toCodexEffort = (effort: ReasoningEffort, supported?: ReadonlyArray<string>): string => {
  const available = ceriumEfforts(supported ?? []);
  if (available.length === 0 || available.includes(effort)) return effort;
  const rank = EFFORT_ORDER.indexOf(effort);
  const above = available.find((candidate) => EFFORT_ORDER.indexOf(candidate) > rank);
  return above ?? available.at(-1) ?? effort;
};

/** One `[mcp_servers.<name>]` table. Trusted servers' tools never prompt; every other tool asks. */
export const toMcpServerConfig = (spec: McpServerSpec, trusted: boolean): Record<string, JsonValue> => {
  const default_tools_approval_mode = trusted ? "approve" : "prompt";
  return spec.type === "http"
    ? {
        url: spec.url,
        ...(spec.headers ? { http_headers: { ...spec.headers } } : {}),
        default_tools_approval_mode,
      }
    : {
        command: spec.command,
        args: [...spec.args],
        ...(spec.env ? { env: { ...spec.env } } : {}),
        default_tools_approval_mode,
      };
};

/** What the adapter reads from the user's effective Codex config (`config/read`) before a thread starts. */
export interface UserConfig {
  /** Names of the `[mcp_servers]` the user (or the project) configured. */
  readonly mcpServers: ReadonlyArray<string>;
  readonly developerInstructions?: string;
}

/**
 * The per-thread `config` overrides. Nested tables are merged into the user's config by Codex, so
 * the user's own servers are switched off by name rather than replaced. Plugins and ChatGPT apps
 * bring MCP servers that cannot be disabled one by one, so excluding the user's servers turns those
 * features off for the thread.
 */
export const threadConfig = (
  options: SessionOptions,
  user: UserConfig,
  effort?: string,
): Record<string, JsonValue> => {
  const trusted = new Set(options.trustedMcpServers ?? []);
  const injected = Object.entries(options.mcpServers).map(
    ([name, spec]) => [name, toMcpServerConfig(spec, trusted.has(name))] as const,
  );
  const disabled = options.includeUserMcpServers
    ? []
    : user.mcpServers
        .filter((name) => !(name in options.mcpServers))
        .map((name) => [name, { enabled: false }] as const);
  return {
    agents: { ...NATIVE_SUBAGENTS_OFF.agents },
    features: {
      ...NATIVE_SUBAGENTS_OFF.features,
      ...(options.includeUserMcpServers ? {} : { apps: false, plugins: false }),
    },
    mcp_servers: Object.fromEntries([...disabled, ...injected]),
    ...(effort === undefined ? {} : { model_reasoning_effort: effort }),
  };
};

/**
 * Parameters shared by `thread/start` and `thread/resume`. Cerium's prompt is added to the user's own
 * `developer_instructions` (which the parameter would otherwise replace); Codex's base instructions
 * stay untouched.
 */
export const threadParams = (options: SessionOptions, user: UserConfig, effort?: string) => {
  const { sandbox, approvalPolicy, approvalsReviewer } = accessPolicy(options.access);
  const developerInstructions = [user.developerInstructions, options.appendSystemPrompt]
    .filter((text): text is string => text !== undefined && text.trim() !== "")
    .join("\n\n");
  return {
    model: options.model,
    cwd: options.cwd,
    approvalPolicy,
    approvalsReviewer,
    sandbox,
    config: threadConfig(options, user, effort),
    ...(developerInstructions === "" ? {} : { developerInstructions }),
  } satisfies ThreadStartParams;
};
