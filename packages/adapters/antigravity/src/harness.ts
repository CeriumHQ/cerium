import {
  defaultToolView,
  metaAt,
  type AcpHarness,
  type ToolCallState,
  type ToolView,
} from "@cerium/adapter-acp";
import { Effect, Predicate } from "effect";

/** The native tool names/inputs are isolated here; ACP itself does not standardize them. */
export const antigravityToolView = (call: ToolCallState): ToolView => {
  const raw = Predicate.isObject(call.rawInput) ? call.rawInput : {};
  const titled = call.title?.replace(/^(?:Running|Run)\s+/, "").replace(/\?$/, "");
  const tool = typeof raw["tool_name"] === "string" ? raw["tool_name"] : (call.name ?? titled);
  const server = metaAt(call.meta, "mcpServerName");
  const mcpTool = metaAt(call.meta, "mcpToolName");
  if (typeof server === "string" && typeof mcpTool === "string") {
    return { name: `mcp__${server}__${mcpTool}`, input: raw };
  }
  if (tool?.startsWith("mcp__")) return { name: tool, input: raw };
  const input = {
    ...raw,
    ...(typeof raw["CommandLine"] === "string" ? { command: raw["CommandLine"] } : {}),
    ...(typeof raw["TargetFile"] === "string" ? { file_path: raw["TargetFile"] } : {}),
    ...(typeof raw["AbsolutePath"] === "string" ? { file_path: raw["AbsolutePath"] } : {}),
  };
  return defaultToolView({ ...call, rawInput: input });
};

export const antigravityHarness: AcpHarness = {
  provider: "antigravity",
  label: "Antigravity",
  sessionParams: (options) => ({
    _meta: {
      antigravity: {
        systemPrompt: {
          append: [
            "Use Cerium's orchestration MCP tools for delegation. Do not start native subagents.",
            "Ask the user questions through Cerium's ask_user MCP tool. Native interactive questions are cancelled.",
            ...(options.access === "readOnly"
              ? ["This session is read-only. Do not edit files or execute commands."]
              : []),
            options.appendSystemPrompt ?? "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      },
    },
  }),
  // Always reset the native mode, even after resume. `default` routes risky tools to ACP rather
  // than inheriting a user's yolo/auto_edit mode. Cerium applies its own access policy there.
  prepare: (connection, sessionId) =>
    connection
      .request("session/set_config_option", {
        sessionId,
        configId: "mode",
        value: "default",
      })
      .pipe(Effect.asVoid),
  view: antigravityToolView,
  // Google sends native choice questions on the permission method with interaction_* tool IDs.
  // Cerium's permission UI cannot select an arbitrary choice: cancelling is safer than silently
  // picking the first allow_once option, especially in fullAccess and for trusted MCP questions.
  cancelPermission: (request) => request.toolCall.toolCallId.startsWith("interaction_"),
};
