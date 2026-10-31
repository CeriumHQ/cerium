// Antigravity's native tools, as its stream and its hooks name them, and how Cerium reads them. Names
// come from prior-art wrappers and Google's docs; argument keys are PascalCase in the stream (`Path`,
// `Command`) and differ in hooks (`CommandLine`), so both are read and lower-case aliases added.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Native tools by the names Cerium's transcript knows. Others keep Antigravity's name. */
const NAMES: Record<string, string> = {
  read_file: "read",
  view_file: "read",
  write_file: "write",
  write_to_file: "write",
  replace_file_content: "edit",
  multi_replace_file_content: "edit",
  sed_file: "edit",
  notebook_edit: "edit",
  run_command: "shell",
  list_dir: "ls",
  find_by_name: "glob",
  grep_search: "grep",
  codesearch: "grep",
  search_web: "websearch",
  read_url_content: "webfetch",
};

/** Tools that only read the workspace or the web. */
const READS = new Set([
  "read_file",
  "view_file",
  "list_dir",
  "find_by_name",
  "grep_search",
  "codesearch",
  "search_web",
  "read_url_content",
  "manage_task",
]);

/** Tools that change files in the workspace (for `acceptEdits`). */
const EDITS = new Set([
  "write_file",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "sed_file",
  "notebook_edit",
]);

/**
 * Tools Cerium never lets run: subagents (Cerium's bus spawns agents) and the question tool (agents ask
 * through `ask_user`).
 */
const WITHHELD = new Set([
  "invoke_subagent",
  "define_subagent",
  "manage_subagents",
  "browser_subagent",
  "ask_question",
]);

export type ToolClass = "read" | "edit" | "withheld" | "other";

export const toolClass = (name: string): ToolClass =>
  WITHHELD.has(name) ? "withheld" : READS.has(name) ? "read" : EDITS.has(name) ? "edit" : "other";

/** Argument keys whose value the transcript reads under another name. */
const ALIASES: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
  [["Path", "AbsolutePath", "TargetFile", "FilePath", "File", "DirectoryPath", "SearchPath"], "path"],
  [["Command", "CommandLine", "Cmd"], "command"],
  [["Query", "SearchQuery"], "query"],
  [["Pattern", "Glob"], "pattern"],
  [["Url", "URL", "Uri"], "url"],
  [["Description", "Summary"], "description"],
  [["Content", "CodeContent", "FileContent"], "content"],
  [["TargetContent", "OldString"], "old_string"],
  [["ReplacementContent", "NewString"], "new_string"],
];

/** A tool's arguments with the lower-case keys Cerium reads added beside Antigravity's own. */
export const normalizedArgs = (args: unknown): Record<string, unknown> => {
  const input: Record<string, unknown> = isRecord(args) ? { ...args } : {};
  for (const [keys, alias] of ALIASES) {
    if (input[alias] !== undefined) continue;
    const key = keys.find((each) => input[each] !== undefined);
    if (key !== undefined) input[alias] = input[key];
  }
  return input;
};

/**
 * An MCP tool as Cerium reports it, `mcp__<server>__<tool>`, from the names Antigravity gives it: a
 * plugin's servers are namespaced `<plugin>_<server>`, and tools read `<server>/<tool>`,
 * `<server>__<tool>` or `mcp_<server>_<tool>` depending on where they're shown.
 */
export const mcpToolName = (
  name: string,
  servers: ReadonlyArray<string>,
  plugin?: string,
): string | undefined => {
  if (/^mcp__.+__.+/.test(name)) return name;
  const prefixes = servers
    .flatMap((server) => [
      ...(plugin === undefined ? [] : [{ server, prefix: `${plugin}_${server}` }]),
      { server, prefix: server },
    ])
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const bare = name.replace(/^mcp_+/, "");
  for (const { server, prefix } of prefixes) {
    for (const separator of ["/", "__", ".", ":", "_"]) {
      const head = `${prefix}${separator}`;
      if (bare.startsWith(head) && bare.length > head.length)
        return `mcp__${server}__${bare.slice(head.length)}`;
    }
  }
  return undefined;
};

/** A tool call as Cerium reports it: its name and the input the transcript reads. */
export const describeTool = (
  name: string,
  args: unknown,
  servers: ReadonlyArray<string>,
  plugin?: string,
): { readonly toolName: string; readonly input: Record<string, unknown> } => {
  const input = normalizedArgs(args);
  const mcp = mcpToolName(name, servers, plugin);
  if (mcp !== undefined) return { toolName: mcp, input: isRecord(args) ? { ...args } : {} };
  return { toolName: NAMES[name] ?? name, input };
};
