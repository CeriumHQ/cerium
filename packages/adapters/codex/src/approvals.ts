import type { PermissionDecision } from "@cerium/harness";
import { posix, win32 } from "node:path";

import type { ServerRequest } from "./protocol/ServerRequest.ts";
import type { CommandExecutionApprovalDecision } from "./protocol/v2/CommandExecutionApprovalDecision.ts";
import type { CommandExecutionRequestApprovalParams } from "./protocol/v2/CommandExecutionRequestApprovalParams.ts";
import type { FileUpdateChange } from "./protocol/v2/FileUpdateChange.ts";
import type { McpServerElicitationRequestResponse } from "./protocol/v2/McpServerElicitationRequestResponse.ts";
import type { PermissionsRequestApprovalResponse } from "./protocol/v2/PermissionsRequestApprovalResponse.ts";
import type { RequestPermissionProfile } from "./protocol/v2/RequestPermissionProfile.ts";
import type { ThreadItem } from "./protocol/v2/ThreadItem.ts";

// Pure decisions about server→client requests: which ones become Cerium approval prompts, how each
// is summarised, and the protocol reply for the user's decision. Every request gets a reply, so a
// request Cerium cannot serve never leaves a turn waiting.

export type RequestHandling =
  | {
      readonly _tag: "Ask";
      readonly toolName: string;
      /** One line for the approval prompt. */
      readonly summary: string;
      readonly input: unknown;
      readonly reply: (decision: PermissionDecision) => unknown;
    }
  /** Answer at once: auto-approved, or a request Cerium declines by design. */
  | { readonly _tag: "Reply"; readonly result: unknown }
  | { readonly _tag: "Fail"; readonly code: number; readonly message: string };

export interface RequestContext {
  readonly cwd: string;
  /** `acceptEdits`: file changes inside `cwd` are approved without asking. */
  readonly approveWorkspaceEdits: boolean;
  readonly trustedMcpServers: ReadonlySet<string>;
  /** The started item an approval is about; requests only carry its id. */
  readonly item: (itemId: string) => ThreadItem | undefined;
  readonly runningMcpCall: (server: string) => Extract<ThreadItem, { type: "mcpToolCall" }> | undefined;
}

const METHOD_NOT_FOUND = -32601;
const DENIED = "Denied by the user in Cerium.";
const SUMMARY_LENGTH = 200;

const oneLine = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > SUMMARY_LENGTH ? `${line.slice(0, SUMMARY_LENGTH - 1)}…` : line;
};

const withReason = (summary: string, reason: string | null | undefined) =>
  oneLine(reason ? `${summary} (${reason})` : summary);

/** Codex reports native paths; Windows ones are compared as such on any OS (e.g. replayed fixtures). */
const pathsFor = (root: string) => (/^[a-zA-Z]:[\\/]|^\\\\/.test(root) ? win32 : posix);

const isInside = (root: string, path: string) => {
  const paths = pathsFor(root);
  const child = paths.relative(root, paths.resolve(root, path));
  return child !== "" && !child.startsWith("..") && !paths.isAbsolute(child);
};

const shown = (cwd: string, path: string) =>
  isInside(cwd, path) ? pathsFor(cwd).relative(cwd, pathsFor(cwd).resolve(cwd, path)) : path;

const changeVerb = (change: FileUpdateChange) => {
  switch (change.kind.type) {
    case "add":
      return "Create";
    case "delete":
      return "Delete";
    case "update":
      return change.kind.move_path ? "Move" : "Edit";
  }
};

export const describeChanges = (changes: ReadonlyArray<FileUpdateChange>, cwd: string): string => {
  const [only] = changes;
  if (only === undefined) return "Change files";
  if (changes.length === 1) return `${changeVerb(only)} ${shown(cwd, only.path)}`;
  return `Change ${changes.length} files: ${changes.map((change) => shown(cwd, change.path)).join(", ")}`;
};

const commandText = (params: CommandExecutionRequestApprovalParams) => {
  const [only, ...rest] = params.commandActions ?? [];
  return only !== undefined && rest.length === 0 ? only.command : (params.command ?? "a command");
};

const describeCommand = (params: CommandExecutionRequestApprovalParams) => {
  if (params.kind === "writeStdin") return withReason("Send input to a running command", params.reason);
  if (params.networkApprovalContext) {
    return withReason(`Allow network access to ${params.networkApprovalContext.host}`, params.reason);
  }
  return withReason(`Run ${commandText(params)}`, params.reason);
};

const describePermissions = (permissions: RequestPermissionProfile, reason: string | null) => {
  const parts = [
    ...(permissions.network?.enabled ? ["network access"] : []),
    ...(permissions.fileSystem?.write?.length
      ? [`writing to ${permissions.fileSystem.write.join(", ")}`]
      : []),
    ...(permissions.fileSystem?.read?.length ? [`reading ${permissions.fileSystem.read.join(", ")}`] : []),
  ];
  return withReason(parts.length === 0 ? "Grant extra permissions" : `Allow ${parts.join(" and ")}`, reason);
};

/** Approve for the session only where the request offers it (some command prompts don't). */
const commandDecision = (
  decision: PermissionDecision,
  offered: ReadonlyArray<unknown> | null | undefined,
): CommandExecutionApprovalDecision => {
  if (decision.decision === "deny") return "decline";
  const sessionOffered = offered == null || offered.includes("acceptForSession");
  return decision.scope === "session" && sessionOffered ? "acceptForSession" : "accept";
};

const elicitationReply = (
  decision: PermissionDecision,
  codexApproval: boolean,
  persistOffered: boolean,
): McpServerElicitationRequestResponse =>
  decision.decision === "deny"
    ? { action: "decline", content: null, _meta: null }
    : {
        action: "accept",
        content: codexApproval ? null : {},
        _meta: decision.scope === "session" && persistOffered ? { persist: "session" } : null,
      };

const isEmptyForm = (schema: unknown) =>
  typeof schema === "object" &&
  schema !== null &&
  Object.keys((schema as { properties?: object }).properties ?? {}).length === 0;

export const handleServerRequest = (request: ServerRequest, context: RequestContext): RequestHandling => {
  switch (request.method) {
    case "item/commandExecution/requestApproval": {
      const { params } = request;
      // `availableDecisions` is marked experimental but sent on 0.162.1; read it when present.
      const offered = (params as { availableDecisions?: ReadonlyArray<unknown> | null }).availableDecisions;
      return {
        _tag: "Ask",
        toolName: "exec_command",
        summary: describeCommand(params),
        input: {
          command: commandText(params),
          cwd: params.cwd,
          ...(params.reason ? { reason: params.reason } : {}),
          ...(params.networkApprovalContext ? { network: params.networkApprovalContext } : {}),
        },
        reply: (decision) => ({ decision: commandDecision(decision, offered) }),
      };
    }

    case "item/fileChange/requestApproval": {
      const { params } = request;
      const item = context.item(params.itemId);
      const changes = item?.type === "fileChange" ? item.changes : [];
      const inWorkspace =
        changes.length > 0 &&
        changes.every(
          (change) =>
            isInside(context.cwd, change.path) &&
            (change.kind.type !== "update" ||
              !change.kind.move_path ||
              isInside(context.cwd, change.kind.move_path)),
        );
      if (context.approveWorkspaceEdits && inWorkspace && !params.grantRoot) {
        return { _tag: "Reply", result: { decision: "accept" } };
      }
      return {
        _tag: "Ask",
        toolName: "apply_patch",
        summary: withReason(describeChanges(changes, context.cwd), params.reason),
        input: { changes, ...(params.grantRoot ? { grantRoot: params.grantRoot } : {}) },
        reply: (decision) => ({
          decision:
            decision.decision === "deny"
              ? "decline"
              : decision.scope === "session"
                ? "acceptForSession"
                : "accept",
        }),
      };
    }

    case "mcpServer/elicitation/request": {
      const { params } = request;
      const meta = (params._meta ?? {}) as { codex_approval_kind?: unknown; persist?: unknown };
      const codexApproval = meta.codex_approval_kind === "mcp_tool_call";
      // Cerium shows yes/no prompts only; forms that ask for data and URL flows are declined.
      if (params.mode === "url" || !(codexApproval || isEmptyForm(params.requestedSchema))) {
        return { _tag: "Reply", result: { action: "decline", content: null, _meta: null } };
      }
      const persistOffered =
        meta.persist === "session" || (Array.isArray(meta.persist) && meta.persist.includes("session"));
      if (codexApproval && context.trustedMcpServers.has(params.serverName)) {
        return { _tag: "Reply", result: elicitationReply({ decision: "allow", scope: "once" }, true, false) };
      }
      const call = codexApproval ? context.runningMcpCall(params.serverName) : undefined;
      return {
        _tag: "Ask",
        toolName: call ? `mcp__${params.serverName}__${call.tool}` : `mcp__${params.serverName}`,
        summary: oneLine(params.message),
        input: call?.arguments ?? {},
        reply: (decision) => elicitationReply(decision, codexApproval, persistOffered),
      };
    }

    case "item/permissions/requestApproval": {
      const { params } = request;
      const { network, fileSystem } = params.permissions;
      return {
        _tag: "Ask",
        toolName: "request_permissions",
        summary: describePermissions(params.permissions, params.reason),
        input: params.permissions,
        reply: (decision): PermissionsRequestApprovalResponse =>
          decision.decision === "deny"
            ? { permissions: {}, scope: "turn" }
            : {
                permissions: { ...(network ? { network } : {}), ...(fileSystem ? { fileSystem } : {}) },
                scope: decision.scope === "session" ? "session" : "turn",
              },
      };
    }

    // The v1 approval requests predate threads; 0.162.1 sends the v2 ones above for v2 threads.
    case "execCommandApproval":
    case "applyPatchApproval": {
      const exec = request.method === "execCommandApproval";
      const { params } = request;
      const summary = exec
        ? `Run ${request.params.command.join(" ")}`
        : `Change ${Object.keys(request.params.fileChanges).join(", ")}`;
      return {
        _tag: "Ask",
        toolName: exec ? "exec_command" : "apply_patch",
        summary: withReason(summary, params.reason),
        input: params,
        reply: (decision) => ({
          decision:
            decision.decision === "deny"
              ? { denied: { rejection: decision.message ?? DENIED } }
              : decision.scope === "session"
                ? "approved_for_session"
                : "approved",
        }),
      };
    }

    // Codex's own question tool, which `threadConfig` keeps off: agents ask through the bus's `ask_user`.
    // Should one arrive anyway, it gets no answers rather than holding the turn.
    case "item/tool/requestUserInput":
      return { _tag: "Reply", result: { answers: {} } };
    // Cerium registers no dynamic tools.
    case "item/tool/call":
      return {
        _tag: "Reply",
        result: { contentItems: [{ type: "inputText", text: "Unknown tool." }], success: false },
      };
    // Credentials belong to the harness; Cerium never supplies tokens or attestations.
    case "account/chatgptAuthTokens/refresh":
    case "attestation/generate":
      return { _tag: "Fail", code: METHOD_NOT_FOUND, message: `Cerium does not handle ${request.method}.` };
    default:
      return {
        _tag: "Fail",
        code: METHOD_NOT_FOUND,
        message: `Cerium does not handle ${(request as { method: string }).method}.`,
      };
  }
};
