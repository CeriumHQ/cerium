import {
  BookOpen,
  FilePen,
  FileText,
  FolderOpen,
  Globe,
  ListChecks,
  Search,
  Square,
  SquareTerminal,
  Trash2,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { toolImageRef, toolOutputImages, type ToolImageRef } from "@cerium/protocol";

import { fileEdits, type FileEdit } from "./diff.ts";
import type { TranscriptBlock } from "./model.ts";

// What the transcript knows about tool calls, whichever harness made them: what each one is called,
// what it was about, whether it failed and why, and what to show of its input and output.

export type ToolBlock = Extract<TranscriptBlock, { kind: "tool" }>;

const field = (input: unknown, key: string): string | undefined => {
  const value =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : undefined;
};

const numberField = (input: unknown, key: string): number | undefined => {
  const value =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>)[key] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const baseName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

/** A patch's text: Muse passes it as `patch`, OpenCode as `patchText`. */
const patchText = (input: unknown): string | undefined =>
  field(input, "patch") ?? field(input, "patchText") ?? (typeof input === "string" ? input : undefined);

/** The files a patch touches: Codex reports its changes, Muse and OpenCode pass the patch text itself. */
const patchedFiles = (input: unknown): ReadonlyArray<string> => {
  const changes =
    typeof input === "object" && input !== null ? (input as { changes?: unknown }).changes : undefined;
  if (Array.isArray(changes)) return changes.flatMap((change) => field(change, "path") ?? []);
  const patch = patchText(input) ?? "";
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1]!.trim());
};

const filesDetail = (files: ReadonlyArray<string>) =>
  files.length === 1 ? baseName(files[0]!) : files.length > 1 ? `${files.length} files` : undefined;

type ToolKind =
  | "read"
  | "edit"
  | "write"
  | "delete"
  | "patch"
  | "search"
  | "list"
  | "run"
  | "fetch"
  | "webSearch";

/**
 * Each harness's built-in tools by what they do: Claude Code, Codex, Muse Code, Cursor and OpenCode
 * name them differently.
 */
const toolKinds: Readonly<Record<string, ToolKind>> = {
  Read: "read",
  read: "read",
  read_file: "read",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  edit: "edit",
  edit_file: "edit",
  Write: "write",
  write: "write",
  write_file: "write",
  delete: "delete",
  apply_patch: "patch",
  patch: "patch",
  Grep: "search",
  Glob: "search",
  grep: "search",
  glob: "search",
  semSearch: "search",
  search: "search",
  ls: "list",
  list_dir: "list",
  Bash: "run",
  PowerShell: "run",
  powershell: "run",
  shell: "run",
  exec_command: "run",
  WebFetch: "fetch",
  webFetch: "fetch",
  web_fetch: "fetch",
  webfetch: "fetch",
  WebSearch: "webSearch",
  webSearch: "webSearch",
  web_search: "webSearch",
  websearch: "webSearch",
};

/** The first line of a string, or nothing when it's blank. */
const firstLine = (text: string | undefined) => text?.trim().split(/\r?\n/, 1)[0]?.trim() || undefined;

/** Input fields that say what a call is about, most telling first. */
const DETAIL_FIELDS = [
  "description",
  "query",
  "url",
  "file_path",
  "path",
  "command",
  "pattern",
  "skill",
  "role",
  "name",
  "title",
  "prompt",
  "text",
];

/** The tools a tool search asked for, without the `mcp__server__` every one starts with. */
const toolNames = (query: string | undefined) =>
  query
    ?.replace(/^select:/, "")
    .replaceAll(/mcp__[^,\s]+?__/g, "")
    .split(",")
    .map((name) => name.trim())
    .join(", ");

/** A list of steps (a browser driver's) as what each did: `click "Save", scroll, +2`. */
const stepsDetail = (input: unknown): string | undefined => {
  const steps = isRecord(input) ? input["steps"] : undefined;
  if (!Array.isArray(steps)) return undefined;
  const named = steps.flatMap((step) => {
    const action = field(step, "action");
    if (!action) return [];
    const target = firstLine(
      field(step, "text") ?? field(step, "selector") ?? field(step, "url") ?? field(step, "keys"),
    );
    return [target ? `${action} “${target}”` : action];
  });
  if (named.length === 0) return undefined;
  const shown = named.slice(0, 3).join(", ");
  return named.length > 3 ? `${shown}, +${named.length - 3}` : shown;
};

/** What a call without a kind of its own is about, from its input. */
const inputDetail = (input: unknown): string | undefined => {
  for (const key of DETAIL_FIELDS) {
    const value = firstLine(field(input, key));
    if (value) return value;
  }
  return stepsDetail(input);
};

/** Harness tools that are neither files, searches nor commands, by what they read as. */
const namedTools: Readonly<
  Record<string, { readonly icon: LucideIcon; readonly verb: string; readonly detail?: boolean }>
> = {
  Skill: { icon: BookOpen, verb: "Use skill", detail: true },
  read_skill: { icon: BookOpen, verb: "Use skill", detail: true },
  ToolSearch: { icon: Wrench, verb: "Load tools", detail: true },
  TodoWrite: { icon: ListChecks, verb: "Update plan" },
  write_todos: { icon: ListChecks, verb: "Update plan" },
  update_plan: { icon: ListChecks, verb: "Update plan" },
  Task: { icon: Workflow, verb: "Delegate", detail: true },
  Agent: { icon: Workflow, verb: "Delegate", detail: true },
  TaskStop: { icon: Square, verb: "Stop task" },
  KillShell: { icon: Square, verb: "Stop task" },
  TaskOutput: { icon: SquareTerminal, verb: "Check task" },
  BashOutput: { icon: SquareTerminal, verb: "Check task" },
};

/** A tool's name as words: `ui_act` reads "UI act", `ToolSearch` "Tool search". */
const toolWords = (name: string) => {
  const words = name
    .replaceAll(/[_-]+/g, " ")
    .replaceAll(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/\b(?:ui|url|api|mcp|pr|id)\b/g, (word) => word.toUpperCase());
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

/** A verb, an icon and the one detail that identifies what a tool call did. */
export const describeTool = (
  tool: ToolBlock,
): {
  readonly icon: LucideIcon;
  readonly verb: string;
  readonly detail?: string;
  readonly mono?: boolean;
} => {
  const { input } = tool;
  const path = field(input, "file_path") ?? field(input, "path");
  const named = path ? { detail: baseName(path) } : {};
  switch (toolKinds[tool.toolName]) {
    case "read":
      return { icon: FileText, verb: "Read", ...named };
    case "edit":
      return { icon: FilePen, verb: "Edit", ...named };
    case "write":
      return { icon: FilePen, verb: "Write", ...named };
    case "delete":
      return { icon: Trash2, verb: "Delete", ...named };
    case "patch": {
      const detail = filesDetail(patchedFiles(input));
      return { icon: FilePen, verb: "Edit", ...(detail ? { detail } : {}) };
    }
    case "search":
      return {
        icon: Search,
        verb: "Search",
        detail: field(input, "pattern") ?? field(input, "globPattern") ?? field(input, "query") ?? "",
        mono: true,
      };
    case "list":
      return { icon: FolderOpen, verb: "List", ...(path ? { detail: path } : {}), mono: true };
    case "run": {
      // The agent's own one-line account of a command reads quicker than the command, which the
      // opened row shows.
      const description = firstLine(field(input, "description"));
      return description
        ? { icon: SquareTerminal, verb: "Run", detail: description }
        : { icon: SquareTerminal, verb: "Run", detail: field(input, "command") ?? "", mono: true };
    }
    case "fetch":
      return { icon: Globe, verb: "Fetch", detail: field(input, "url") ?? "" };
    case "webSearch":
      return { icon: Globe, verb: "Search the web", detail: field(input, "query") ?? "" };
    default: {
      const detail = (
        tool.toolName === "ToolSearch" ? toolNames(inputDetail(input)) : inputDetail(input)
      )?.replace(/^select:/, "");
      const known = namedTools[tool.toolName];
      if (known) {
        return { icon: known.icon, verb: known.verb, ...(known.detail && detail ? { detail } : {}) };
      }
      const [, server, name] = /^mcp__(.+?)__(.+)$/.exec(tool.toolName) ?? [];
      if (server && name) return { icon: Workflow, verb: toolWords(name), detail: detail ?? server };
      return { icon: Wrench, verb: toolWords(tool.toolName), ...(detail ? { detail } : {}) };
    }
  }
};

/** Long base64 (an image in a tool's output) shows as its size instead of a wall of characters. */
const withoutBlobs = (_key: string, value: unknown) =>
  typeof value === "string" && value.length > 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(value.slice(-64))
    ? `[${Math.round((value.length * 3) / 4 / 1024)} KB of base64]`
    : value;

/**
 * A command's result as Codex (`{output, exitCode}`), Cursor (`{exitCode, stdout, stderr, …}`) and
 * Muse (`{command, exit_code, output, …}`, as JSON text) report it, read the way Claude Code's Bash
 * tool gives one: an "Exit code N" line when it failed, then what it printed. Undefined for anything
 * else.
 */
const commandText = (output: Record<string, unknown>): string | undefined => {
  const key = "exitCode" in output ? "exitCode" : "exit_code" in output ? "exit_code" : undefined;
  const exitCode = key === undefined ? undefined : output[key];
  if (key === undefined || (exitCode !== null && typeof exitCode !== "number")) return undefined;
  const printed = ["output", "stdout", "stderr"].flatMap((name) => (name in output ? [output[name]] : []));
  if (printed.length === 0 || !printed.every((value): value is string => typeof value === "string")) {
    return undefined;
  }
  const text = printed
    .map((value) => value.trimEnd())
    .filter(Boolean)
    .join("\n");
  return typeof exitCode === "number" && exitCode !== 0 ? `Exit code ${exitCode}\n${text}` : text;
};

/**
 * Text that is JSON, laid out for reading; anything else as it is. A result that is nothing but a
 * message (`{"error": "…"}`) reads as the message, and a command's result as what it printed.
 */
const prettyJson = (text: string): string => {
  const trimmed = text.trim();
  // Numbers past what a double holds exactly would come back altered, so such JSON stays as written.
  if (!/^[{[]/.test(trimmed) || trimmed.length > 100_000 || /\d{16,}/.test(trimmed)) return text;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (isRecord(value) && !Array.isArray(value)) {
      const command = commandText(value);
      if (command !== undefined) return command;
      const keys = Object.keys(value);
      const only = keys.length === 1 ? value[keys[0]!] : undefined;
      if ((keys[0] === "error" || keys[0] === "message") && typeof only === "string") return only;
    }
    return JSON.stringify(value, null, 2);
  } catch {
    return text;
  }
};

const isImageItem = (value: unknown) => isRecord(value) && value["type"] === "image";

/**
 * A tool's output as the text a person reads. MCP and Anthropic outputs are lists of content items,
 * so their text items stand for them (JSON laid out, images left to the thumbnails); anything else
 * is shown as JSON with blobs elided.
 */
const textOf = (output: unknown): string => {
  if (output === undefined || output === null) return "";
  if (typeof output === "string") return prettyJson(output);
  if (Array.isArray(output)) {
    return output
      .filter((item) => !isImageItem(item))
      .map(textOf)
      .filter((text) => text !== "")
      .join("\n\n");
  }
  if (isRecord(output)) {
    if (isImageItem(output)) return "";
    if (output["type"] === "text" && typeof output["text"] === "string") return prettyJson(output["text"]);
    const command = commandText(output);
    if (command !== undefined) return command;
    if (
      Array.isArray(output["content"]) &&
      Object.keys(output).every((key) => key === "content" || key === "isError")
    ) {
      return textOf(output["content"]);
    }
  }
  return JSON.stringify(output, withoutBlobs, 2);
};

/**
 * Each output's text, by the output. An output is its event's own and never changes, while laying it
 * out parses and prints its JSON again, and the transcript asks for it on every update.
 */
const texts = new WeakMap<object, string>();

/** A tool's output as the text a person reads (see `textOf`). */
export const outputText = (output: unknown): string => {
  if (typeof output !== "object" || output === null) return textOf(output);
  const known = texts.get(output);
  if (known !== undefined) return known;
  const text = textOf(output);
  texts.set(output, text);
  return text;
};

/** What the tool's input shows in its place when it isn't a plain string. */
const inputText = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, withoutBlobs, 2);

/** The reason a JSON result gives for failing, in an `error` or `message` field near its top. */
const reasonIn = (value: unknown, depth = 0): string | undefined => {
  if (!isRecord(value) || depth > 2) return undefined;
  for (const key of ["error", "message", "reason"]) {
    if (typeof value[key] === "string" && value[key] !== "") return value[key];
  }
  for (const nested of Object.values(value)) {
    const found = reasonIn(nested, depth + 1);
    if (found) return found;
  }
  return undefined;
};

const ERROR_WORDS =
  /\b(?:errors?|failed|failure|fatal|cannot|can't|couldn't|not found|no such|denied|refused|invalid|unexpected|missing|blocked)\b/i;

const EXIT_LINE = /^Exit code (\d+)\r?\n?/;

/** A shell command's exit code, from the first line Claude Code's Bash tool puts on a failure. */
export const exitCodeOf = (text: string): number | undefined => {
  const code = EXIT_LINE.exec(text.trimStart())?.[1];
  return code === undefined ? undefined : Number(code);
};

/** The output without its leading exit-code line, which the output panel shows as a badge. */
export const withoutExitLine = (text: string): string => text.trimStart().replace(EXIT_LINE, "");

/**
 * One line saying why a call failed: the exit code and the line of output that names the problem,
 * or the reason a JSON result gives. Undefined when the output says nothing.
 */
export const failureLine = (output: unknown): string | undefined => {
  const text = outputText(output)
    .replaceAll(/<\/?tool_use_error>/g, "")
    .trim();
  if (text.startsWith("{")) {
    try {
      const reason = firstLine(reasonIn(JSON.parse(text)));
      if (reason) return reason;
    } catch {
      // Not JSON after all; read it as lines.
    }
  }
  const exit = exitCodeOf(text);
  const lines = (exit === undefined ? text : withoutExitLine(text))
    .split(/\r?\n/)
    .map((line) => line.trim())
    // Lines of nothing but punctuation, such as JSON's braces, say nothing.
    .filter((line) => /[\p{L}\p{N}]/u.test(line));
  const line = lines.find((each) => ERROR_WORDS.test(each)) ?? lines.at(-1);
  return [exit === undefined ? undefined : `Exit ${exit}`, line].filter(Boolean).join(" · ") || undefined;
};

/** What a tool row's right-click menu offers; each part is absent when the call has nothing for it. */
export interface ToolMenuPlan {
  /** The one thing the call is about, and how its menu item reads: "Copy command", "Copy URL". */
  readonly copy?: { readonly label: string; readonly text: string };
  /** A file the call names, as written (it may be relative). */
  readonly path?: string;
  /** An https page the call fetched. */
  readonly url?: string;
  /** What the Output panel shows. */
  readonly output?: string;
}

/** What a tool call's menu copies and opens, by the kind of tool; anything unplaced copies its input. */
export const toolMenuPlan = (tool: ToolBlock): ToolMenuPlan => {
  const { input } = tool;
  const path = field(input, "file_path") ?? field(input, "path");
  const copyInput = (): Pick<ToolMenuPlan, "copy"> =>
    input === undefined ? {} : { copy: { label: "Copy input", text: inputText(input) } };
  // Images are shown as thumbnails, so only the text beside them is left to copy.
  const shown = tool.output === undefined ? "" : outputText(tool.output);
  const output = shown === "" ? {} : { output: shown };
  const text = (label: string, value: string | undefined) =>
    value ? { copy: { label, text: value } } : copyInput();
  const named = (file: string | undefined) =>
    file ? { copy: { label: "Copy path", text: file }, path: file } : copyInput();
  switch (toolKinds[tool.toolName]) {
    case "read":
    case "edit":
    case "write":
    case "delete":
    case "list":
      return { ...named(path), ...output };
    case "patch": {
      const files = patchedFiles(input);
      return { ...(files.length === 1 ? named(files[0]) : copyInput()), ...output };
    }
    case "run":
      return { ...text("Copy command", field(input, "command")), ...output };
    case "search":
      return {
        ...text(
          "Copy pattern",
          field(input, "pattern") ?? field(input, "globPattern") ?? field(input, "query"),
        ),
        ...output,
      };
    case "webSearch":
      return { ...text("Copy query", field(input, "query")), ...output };
    case "fetch": {
      const url = field(input, "url");
      return {
        ...text("Copy URL", url),
        ...(url && /^https:\/\//i.test(url) ? { url } : {}),
        ...output,
      };
    }
    default:
      return { ...copyInput(), ...output };
  }
};

/** What an opened tool row shows of the call's input, by the kind of tool. */
export type ToolInputView =
  /** A file edit, as a diff. */
  | { readonly kind: "diff"; readonly edits: ReadonlyArray<FileEdit> }
  /** Text to read as written: a shell command, a patch, an unnamed tool's input. */
  | { readonly kind: "code"; readonly label: string; readonly text: string }
  /** The one thing the call names: a file, a pattern in a place, an address. */
  | { readonly kind: "subject"; readonly text: string };

const rangeOf = (input: unknown): string | undefined => {
  const offset = numberField(input, "offset");
  const limit = numberField(input, "limit");
  if (offset === undefined && limit === undefined) return undefined;
  const from = (offset ?? 0) + 1;
  return limit === undefined ? `from line ${from}` : `lines ${from}–${from + limit - 1}`;
};

/** The input an opened row shows, or nothing when the row's own line already says it all. */
export const toolInputView = (tool: ToolBlock): ToolInputView | undefined => {
  const { input } = tool;
  if (input === undefined || input === null) return undefined;
  const edits = fileEdits(input);
  if (edits.length > 0) return { kind: "diff", edits };
  const path = field(input, "file_path") ?? field(input, "path");
  switch (toolKinds[tool.toolName]) {
    case "run": {
      const command = field(input, "command");
      return command ? { kind: "code", label: "Command", text: command } : undefined;
    }
    case "patch": {
      const patch = patchText(input);
      return patch ? { kind: "code", label: "Patch", text: patch } : undefined;
    }
    case "read":
    case "edit":
    case "write":
    case "delete":
    case "list": {
      const range = rangeOf(input);
      return path ? { kind: "subject", text: range ? `${path} · ${range}` : path } : undefined;
    }
    case "search": {
      const pattern = field(input, "pattern") ?? field(input, "globPattern") ?? field(input, "query");
      return pattern ? { kind: "subject", text: path ? `${pattern} in ${path}` : pattern } : undefined;
    }
    case "fetch": {
      const url = field(input, "url");
      return url ? { kind: "subject", text: url } : undefined;
    }
    case "webSearch": {
      const query = field(input, "query");
      return query ? { kind: "subject", text: query } : undefined;
    }
    default: {
      if (isRecord(input) && Object.keys(input).length === 0) return undefined;
      return { kind: "code", label: "Input", text: inputText(input) };
    }
  }
};

/** An image a tool call showed the agent: its bytes from the call's output, or the file it read. */
export interface ToolImage {
  readonly key: string;
  readonly name: string;
  /** A data URL, when the output carried the image itself. */
  readonly url?: string;
  /** Where to read it, when the thread's history left the image out. */
  readonly ref?: ToolImageRef;
  /** An absolute path the backend can read, otherwise. */
  readonly path?: string;
}

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i;
const ABSOLUTE = /^(?:[a-z]:[\\/]|[\\/])/i;

/** The images a tool call showed the agent, such as a screenshot it read or one a tool returned. */
export const toolImages = (tool: ToolBlock): ReadonlyArray<ToolImage> => {
  const path = field(tool.input, "file_path") ?? field(tool.input, "path");
  const name = path ? baseName(path) : "Image";
  const inline = toolOutputImages(tool.output);
  if (inline.length > 0) {
    return inline.map((image, index) => {
      const ref = toolImageRef(image.data);
      return {
        key: `${tool.id}:${index}`,
        name: inline.length === 1 ? name : `${name} (${index + 1})`,
        ...(ref === undefined ? { url: `data:${image.mediaType};base64,${image.data}` } : { ref }),
      };
    });
  }
  // Harnesses that only report the path: the file is read again to show it.
  const saved = field(tool.output, "savedPath");
  const file = toolKinds[tool.toolName] === "read" || tool.toolName === "view_image" ? path : saved;
  if (tool.status === "done" && file && IMAGE_FILE.test(file) && ABSOLUTE.test(file)) {
    return [{ key: tool.id, name: baseName(file), path: file }];
  }
  return [];
};

const count = (n: number, one: string, many: string, done = "") =>
  `${n} ${n === 1 ? one : many}${done ? ` ${done}` : ""}`;

const normalPath = (path: string) => path.replaceAll("\\", "/");

/** What a stretch of tool calls did, counted by kind: "3 files read, 2 commands run". */
export const summarizeTools = (tools: ReadonlyArray<ToolBlock>): string => {
  const read = new Set<string>();
  const edited = new Set<string>();
  const deleted = new Set<string>();
  const calls = { search: 0, list: 0, run: 0, fetch: 0, webSearch: 0, other: 0 };
  for (const tool of tools) {
    const kind = toolKinds[tool.toolName];
    const path = field(tool.input, "file_path") ?? field(tool.input, "path");
    // A call whose file can't be told apart still counts once.
    const files = kind === "patch" ? patchedFiles(tool.input) : path ? [path] : tool.changedFiles;
    const keys = files.length > 0 ? files.map(normalPath) : [tool.id];
    switch (kind) {
      case "read":
        for (const key of keys) read.add(key);
        break;
      case "edit":
      case "write":
      case "patch":
        for (const key of keys) edited.add(key);
        break;
      case "delete":
        for (const key of keys) deleted.add(key);
        break;
      case undefined:
        calls.other++;
        break;
      default:
        calls[kind]++;
    }
  }
  const parts = [
    read.size > 0 && count(read.size, "file", "files", "read"),
    calls.search > 0 && count(calls.search, "search", "searches"),
    calls.list > 0 && count(calls.list, "folder", "folders", "listed"),
    calls.fetch > 0 && count(calls.fetch, "page", "pages", "fetched"),
    calls.webSearch > 0 && count(calls.webSearch, "web search", "web searches"),
    edited.size > 0 && count(edited.size, "file", "files", "edited"),
    deleted.size > 0 && count(deleted.size, "file", "files", "deleted"),
    calls.run > 0 && count(calls.run, "command", "commands", "run"),
  ].filter((part) => part !== false);
  // Counted as calls: five calls of one tool aren't five tools.
  if (calls.other > 0) {
    parts.push(
      parts.length > 0
        ? count(calls.other, "other tool call", "other tool calls")
        : count(calls.other, "tool call", "tool calls"),
    );
  }
  return parts.join(", ");
};
