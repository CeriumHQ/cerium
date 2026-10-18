import { compareVersions, type McpServerSpec, type PermissionDecision } from "@cerium/harness";
import type { AccessMode, ReasoningEffort } from "@cerium/protocol";
import { EXPECTED_SCHEMA_FINGERPRINT } from "@muse-code/sdk";
import type {
  ApprovalChoice,
  ApprovalMode,
  ApprovalRequestParams,
  ReasoningEffort as MuseEffort,
  SessionMcpServerConfig,
} from "@muse-code/sdk/dist/src/msp.js";

import { SDK_RELEASE } from "./manifest.ts";

// How Cerium's session options map onto `muse serve` flags and MSP params. Pure, so every mapping is unit
// tested without a host.

export interface AccessPolicy {
  /** A built-in profile from `permissionProfile/list`, picked at `session/start` or `session/resume`. */
  readonly permissionProfile: string;
  readonly approvalMode: ApprovalMode;
  /** Sandbox posture is fixed per host process, so it rides on the `muse serve` command line. */
  readonly serveFlags: ReadonlyArray<string>;
}

/**
 * Muse auto-approves in-workspace `write_file`/`edit_file` in every approval mode, so `ask` and
 * `acceptEdits` behave the same: edits apply, while shell stages without an allow rule, new network
 * targets, protected and out-of-workspace writes and MCP tools ask (`promptUnmatched`, the CLI's
 * `untrusted`). `:ask-me` keeps a human, not the LLM judge, as the reviewer; `auto` is Muse's
 * `:auto-review` profile, where the judge decides and hands the user only what it escalates. `fullAccess` is Muse's
 * `:unrestricted` profile (no reviewer) with nothing asking, on a host without the shell sandbox.
 */
export const accessPolicy = (access: AccessMode): AccessPolicy => {
  switch (access) {
    case "readOnly":
      return {
        permissionProfile: ":read-only",
        approvalMode: "promptUnmatched",
        serveFlags: ["--disable-write", "--disable-shell"],
      };
    case "ask":
    case "acceptEdits":
      return { permissionProfile: ":ask-me", approvalMode: "promptUnmatched", serveFlags: [] };
    case "auto":
      return { permissionProfile: ":auto-review", approvalMode: "promptUnmatched", serveFlags: [] };
    case "fullAccess":
      return {
        permissionProfile: ":unrestricted",
        approvalMode: "allowAll",
        serveFlags: ["--disable-sandbox"],
      };
  }
};

/**
 * Per-host settings for every Cerium session. Cerium's bus is the only way to spawn (architecture §3.1):
 * native subagent tools are hidden, the `workflow` tool is removed and the agent tree has no child slot.
 * Unknown keys refuse the run, so each one here was checked against the installed CLI.
 */
const HOST_SETTINGS: ReadonlyArray<readonly [string, unknown]> = [
  ["run.subagent_delegation_mode", "off"],
  ["run.workflow_trigger_mode", "off"],
  ["agents.execution_capacity", 1],
];

export interface ServeOptions {
  readonly access: AccessMode;
  readonly appendSystemPrompt?: string | undefined;
  /** Test seam: `echo` drives the full protocol with no account. Cerium itself never sets it. */
  readonly provider?: "echo" | undefined;
}

export const serveArgs = (options: ServeOptions): ReadonlyArray<string> => [
  "serve",
  ...(options.provider ? ["--provider", options.provider] : []),
  // Cerium has no user-input dialog; the model asks in its reply instead.
  "--disable-request-user-input",
  ...accessPolicy(options.access).serveFlags,
  ...HOST_SETTINGS.flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]),
  // A developer-role prompt beside Muse's own base instructions, not a replacement for them.
  ...(options.appendSystemPrompt
    ? ["-c", `run.developer_prompt=${JSON.stringify(options.appendSystemPrompt)}`]
    : []),
];

/** MSP's `config.mcpServers` entry for one injected server. */
export const toSessionMcp = (spec: McpServerSpec): SessionMcpServerConfig =>
  spec.type === "http"
    ? {
        transport: "streamableHttp",
        url: spec.url,
        ...(spec.headers ? { headers: { ...spec.headers } } : {}),
      }
    : {
        transport: "stdio",
        command: spec.command,
        args: [...spec.args],
        ...(spec.env ? { env: { ...spec.env } } : {}),
      };

/** Muse's tiers, lowest first. Cerium has no `none` or `ultra`. */
const MUSE_TIERS: ReadonlyArray<MuseEffort> = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
const CERIUM_EFFORTS: ReadonlyArray<ReasoningEffort> = ["minimal", "low", "medium", "high", "xhigh", "max"];

const isCeriumEffort = (tier: string): tier is ReasoningEffort =>
  (CERIUM_EFFORTS as ReadonlyArray<string>).includes(tier);

/**
 * Cerium's effort as a Muse tier. The names are shared; when the model's catalog row offers a narrower
 * set, the nearest offered tier is used (the lower one on a tie). An unknown set passes the name through.
 */
export const toMuseEffort = (effort: ReasoningEffort, offered?: ReadonlyArray<string>): MuseEffort => {
  const tiers = MUSE_TIERS.filter((tier) => offered?.includes(tier) && tier !== "none");
  if (tiers.length === 0 || tiers.includes(effort)) return effort;
  const rank = MUSE_TIERS.indexOf(effort);
  return tiers.reduce((best, tier) =>
    Math.abs(MUSE_TIERS.indexOf(tier) - rank) < Math.abs(MUSE_TIERS.indexOf(best) - rank) ? tier : best,
  );
};

/** A catalog row's efforts in Cerium's vocabulary, lowest first. `none` and `ultra` are not offered. */
export const ceriumEfforts = (variants: ReadonlyArray<string> | "unknown" | undefined) =>
  variants === undefined || variants === "unknown"
    ? []
    : CERIUM_EFFORTS.filter((effort) => variants.includes(effort));

export const ceriumEffort = (tier: string | undefined): ReasoningEffort | undefined =>
  tier !== undefined && isCeriumEffort(tier) ? tier : undefined;

/**
 * The server-minted choice that carries out Cerium's decision. `session` scope prefers the session grant
 * and falls back to a one-time approval; choices that persist a workspace rule are never picked. When
 * nothing fits (an allow with no approve choice), the request is denied rather than left parked.
 */
export const pickApprovalChoice = (
  choices: ReadonlyArray<ApprovalChoice>,
  decision: Pick<PermissionDecision, "decision" | "scope">,
): ApprovalChoice | undefined => {
  const find = (predicate: (choice: ApprovalChoice) => boolean) => choices.find(predicate);
  const deny = () =>
    find((choice) => choice.decision === "denied") ?? find((choice) => choice.decision === "abort");
  if (decision.decision === "deny") return deny();
  const forSession =
    decision.scope === "session"
      ? (find((choice) => choice.decision === "approvedForSession") ??
        find((choice) => choice.decision === "approved" && choice.scope === "session"))
      : undefined;
  return (
    forSession ??
    find((choice) => choice.decision === "approved" && choice.scope === "once") ??
    find((choice) => choice.decision === "approved") ??
    find((choice) => choice.decision === "approvedForSession") ??
    deny()
  );
};

/** What a decision actually did, read back from the choice that carried it. */
export const choiceOutcome = (choice: ApprovalChoice): Pick<PermissionDecision, "decision" | "scope"> =>
  choice.decision.startsWith("approved")
    ? { decision: "allow", scope: choice.decision === "approvedForSession" ? "session" : "once" }
    : { decision: "deny", scope: "once" };

/** A decision recorded by someone other than Cerium (policy, a session grant, another client). */
export const decisionOutcome = (decision: string): Pick<PermissionDecision, "decision" | "scope"> =>
  decision.startsWith("approved")
    ? { decision: "allow", scope: decision === "approved" ? "once" : "session" }
    : { decision: "deny", scope: "once" };

const clip = (text: string, max = 200) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** One line for the approval inbox, built from the server's subject rather than the raw arguments. */
export const approvalSummary = (request: ApprovalRequestParams): string => {
  const { subject } = request;
  switch (subject.kind) {
    case "shell": {
      const { approvalId, sourceIndex } = request.currentRequirementId;
      const held = subject.stages?.find(
        (stage) =>
          stage.requirementId.approvalId === approvalId && stage.requirementId.sourceIndex === sourceIndex,
      );
      // A compound command is reviewed stage by stage; name the stage being asked about.
      const command = held?.argv.join(" ") ?? subject.command ?? request.rawArgs;
      return clip(`Run \`${command}\``);
    }
    case "fileAccess": {
      const access = subject.access
        ? subject.access.charAt(0).toUpperCase() + subject.access.slice(1)
        : "Access";
      return clip(`${access} ${subject.path ?? subject.target ?? "a file"}`);
    }
    case "network": {
      const target = subject.host
        ? `${subject.host}${subject.port ? `:${subject.port}` : ""}`
        : subject.target;
      return clip(`Connect to ${target ?? "the network"}${subject.protocol ? ` (${subject.protocol})` : ""}`);
    }
    case "process":
      return clip(`Start \`${subject.command ?? subject.target ?? request.toolName}\``);
    case "tool":
      return clip(`Use ${subject.toolName ?? request.toolName}`);
    default:
      return clip(`${request.toolName}: ${subject.kind}${subject.target ? ` ${subject.target}` : ""}`);
  }
};

/** MCP tools are named `mcp__<server>__<tool>`; only those of trusted servers skip Cerium's inbox. */
export const isTrustedTool = (request: ApprovalRequestParams, trustedServers: ReadonlyArray<string>) => {
  if (request.subject.kind !== "tool") return false;
  const name = request.subject.toolName ?? request.toolName;
  return trustedServers.some((server) => name.startsWith(`mcp__${server}__`));
};

export type FingerprintVerdict = "exact" | "additive" | "incompatible";

/**
 * Compares the host's stable MSP schema with the one the SDK was built for. The SDK documents stable
 * evolution as additive, so a newer host is accepted; a host at or below the SDK's release that serves a
 * different schema is one the SDK cannot rely on.
 */
export const fingerprintVerdict = (
  served: string,
  hostVersion: string,
  pinned: string = EXPECTED_SCHEMA_FINGERPRINT,
): FingerprintVerdict => {
  if (served === pinned) return "exact";
  return compareVersions(hostVersion, SDK_RELEASE) > 0 ? "additive" : "incompatible";
};
