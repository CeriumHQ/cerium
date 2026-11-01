import {
  defaultToolView,
  metaAt,
  outputOf,
  standardUsage,
  type AcpConnection,
  type AcpHarness,
  type CompactionCounts,
  type LiveSessions,
  type Params,
  type PromptResult,
  type ToolCallState,
  type ToolView,
  type TurnContext,
  type TurnTotals,
} from "@cerium/adapter-acp";
import type { SessionOptions } from "@cerium/harness";
import { Effect } from "effect";

import { LOGIN_COMMAND } from "./manifest.ts";
import { contextWindowOf } from "./models.ts";

// What Grok adds to ACP: its session options, its tools' own names (`_meta["x.ai/tool"]`), the usage
// each prompt's answer carries, and its compaction.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Grok's own description of a tool call: its tool's name, kind and whether it only reads. */
const grokTool = (call: ToolCallState) => {
  const tool = call.meta?.["x.ai/tool"];
  return isRecord(tool) ? tool : undefined;
};

/** Grok's built-in tools, by the names Cerium's transcript knows them. */
const TOOL_NAMES: Readonly<Record<string, string>> = {
  read_file: "Read",
  search_replace: "Edit",
  hashline_edit: "Edit",
  write: "Write",
  delete_file: "delete",
  apply_patch: "apply_patch",
  grep: "Grep",
  list_dir: "ls",
  run_terminal_command: "Bash",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
  todo_write: "TodoWrite",
  spawn_subagent: "Task",
  search_tool: "ToolSearch",
};

/** The input fields Grok names its own way, under the names Cerium's transcript reads. */
const renamed = (input: unknown): Record<string, unknown> => {
  if (!isRecord(input)) return {};
  const { variant: _variant, target_file: file, target_directory: folder, ...rest } = input;
  return {
    ...rest,
    ...(text(file) === undefined || rest["file_path"] !== undefined ? {} : { file_path: file }),
    ...(text(folder) === undefined || rest["path"] !== undefined ? {} : { path: folder }),
  };
};

/**
 * A Grok tool call as Cerium shows it: its built-in tools by the names the transcript knows, and an
 * MCP tool it runs through `use_tool` as `mcp__<server>__<tool>`, with the tool's own input.
 */
export const grokToolView = (call: ToolCallState): ToolView => {
  const name = text(grokTool(call)?.["name"]);
  if (name === "use_tool") {
    const target = text(metaAt(call.rawInput, "tool_name"));
    const split = target?.indexOf("__") ?? -1;
    if (target !== undefined && split > 0) {
      const input = metaAt(call.rawInput, "tool_input");
      return { name: `mcp__${target.slice(0, split)}__${target.slice(split + 2)}`, input: input ?? {} };
    }
  }
  // Grok's first title for a call is its tool's own name, which says nothing beside it.
  const { title: _title, ...untitled } = call;
  const view = defaultToolView({
    ...(call.title === name ? untitled : call),
    ...(name === undefined ? {} : { name }),
    rawInput: renamed(call.rawInput),
  });
  return { name: (name === undefined ? undefined : TOOL_NAMES[name]) ?? view.name, input: view.input };
};

/**
 * What a Grok tool told its model, from the result its output names (`EditsApplied`, `FileContent`, …):
 * `{ type: "SearchReplace", EditsApplied: { tool_output_for_prompt: "The file … has been updated" } }`.
 */
const toolText = (raw: unknown): string | undefined => {
  if (!isRecord(raw)) return undefined;
  const direct = text(raw["output_for_prompt"]) ?? text(raw["tool_output_for_prompt"]);
  if (direct !== undefined) return direct;
  for (const result of Object.values(raw)) {
    if (!isRecord(result)) continue;
    const found =
      text(result["tool_output_for_prompt"]) ?? text(result["output_for_prompt"]) ?? text(result["content"]);
    if (found !== undefined) return found;
  }
  return undefined;
};

/**
 * What a finished Grok call shows: its text, else what the tool told the model. An edit shows only its
 * diff, whose file the input already names, so it shows the tool's confirmation instead.
 */
export const grokOutput = (call: ToolCallState): unknown => {
  const diffsOnly = call.content.length > 0 && call.content.every((content) => content.type === "diff");
  const shown = diffsOnly ? "" : outputOf(call);
  if (typeof shown === "string" && shown !== "") return shown;
  const raw = call.rawOutput;
  const fromTool = toolText(raw);
  if (fromTool !== undefined) return fromTool;
  // An MCP tool's result, as `{ OkayOutput: … }` or its error.
  const result = metaAt(raw, "output");
  const fromMcp = isRecord(result) ? Object.values(result)[0] : undefined;
  if (fromMcp !== undefined) return fromMcp;
  return diffsOnly ? outputOf(call) : (raw ?? "");
};

/** Whether Grok marks the call as only reading. */
export const grokReadsOnly = (call: ToolCallState): boolean | undefined => {
  const readOnly = grokTool(call)?.["read_only"];
  return typeof readOnly === "boolean" ? readOnly : undefined;
};

/**
 * A turn's usage from Grok's own count (`_meta.usage`): its input counts cache reads, which Cerium
 * counts apart, and its cost comes in ten-billionths of a dollar. The context is the last request's.
 */
export const grokUsage = (result: PromptResult, session: TurnContext): TurnTotals => {
  const meta = result._meta ?? undefined;
  const usage = metaAt(meta, "usage");
  const input = finite(metaAt(usage, "inputTokens"));
  const output = finite(metaAt(usage, "outputTokens"));
  if (input === undefined || output === undefined) return standardUsage(result);
  const cached = finite(metaAt(usage, "cachedReadTokens")) ?? 0;
  const ticks = finite(metaAt(usage, "costUsdTicks"));
  const partial = metaAt(usage, "costIsPartial") === true || metaAt(usage, "usageIsIncomplete") === true;
  const tokens = finite(metaAt(meta, "totalTokens")) ?? finite(metaAt(meta, "inputTokens"));
  const model = text(metaAt(meta, "modelId")) ?? session.model;
  const window =
    contextWindowOf(session.initialized, model) ?? contextWindowOf(session.initialized, session.model);
  return {
    usage: {
      inputTokens: Math.max(0, input - cached),
      outputTokens: output,
      ...(cached > 0 ? { cachedInputTokens: cached } : {}),
      ...(ticks === undefined || partial ? {} : { costUsd: ticks / 1e10 }),
    },
    ...(tokens === undefined ? {} : { context: { tokens, ...(window === undefined ? {} : { window }) } }),
  };
};

/** A compaction Grok reports, its own or one Cerium asked for. */
export const grokCompaction = (method: string, params: Params): CompactionCounts | undefined => {
  if (method !== "_x.ai/session_notification") return undefined;
  const update = params["update"];
  if (!isRecord(update) || update["sessionUpdate"] !== "auto_compact_completed") return undefined;
  const tokensBefore = finite(update["tokens_before"]);
  const tokensAfter = finite(update["tokens_after"]);
  const summary = text(update["summary_preview"]);
  return {
    ...(tokensBefore === undefined ? {} : { tokensBefore }),
    ...(tokensAfter === undefined ? {} : { tokensAfter }),
    ...(summary === undefined ? {} : { summary }),
  };
};

/**
 * Read-only access as Grok's model hears it. Grok has no read-only tool set over ACP, and a call Cerium
 * refuses ends Grok's turn, so the model is told up front.
 */
export const READ_ONLY_RULE =
  "This session is read-only: read and search the workspace, but don't edit files or run commands. " +
  "Each edit or command is refused, and a refusal ends your turn.";

/**
 * Grok's documented `session/new` options. `yoloMode` is always given, so a user who set Grok to
 * always approve still has its tool calls asked of Cerium; `autoMode` is Grok's own reviewer; `rules`
 * are appended to Grok's system prompt.
 */
export const grokSessionParams = (options: SessionOptions) => {
  const rules = [
    ...(options.access === "readOnly" ? [READ_ONLY_RULE] : []),
    ...(options.appendSystemPrompt === undefined || options.appendSystemPrompt === ""
      ? []
      : [options.appendSystemPrompt]),
  ];
  return {
    _meta: {
      yoloMode: options.access === "fullAccess",
      autoMode: options.access === "auto",
      ...(rules.length === 0 ? {} : { rules: rules.join("\n\n") }),
    },
  };
};

/**
 * Readiness from Grok's MCP notices: each server's status as it settles (`_x.ai/mcp/server_status`:
 * `ready`, `needsauth`, `unavailable`, or `initializing` while it connects), then
 * `_x.ai/mcp_initialized` once every server has, the user's own among them, so one slow server of
 * theirs holds that one back.
 */
export const grokReady = (method: string, params: Params): boolean | string | undefined => {
  if (method === "_x.ai/mcp_initialized") return true;
  if (method !== "_x.ai/mcp/server_status") return undefined;
  const name = text(params["name"]);
  return name === undefined || params["status"] === "initializing" ? undefined : name;
};

const compact = (connection: AcpConnection, sessionId: string) =>
  connection
    .request("_x.ai/compact_conversation", { sessionId })
    .pipe(Effect.as({} satisfies CompactionCounts));

export const grokHarness = (live: LiveSessions): AcpHarness => ({
  provider: "grok",
  label: "Grok Build",
  loginCommand: LOGIN_COMMAND,
  sessionParams: grokSessionParams,
  ready: grokReady,
  view: grokToolView,
  output: grokOutput,
  readsOnly: grokReadsOnly,
  usage: grokUsage,
  compaction: grokCompaction,
  compact,
  live,
});
