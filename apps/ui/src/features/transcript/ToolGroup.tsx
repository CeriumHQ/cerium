import { Collapsible } from "@base-ui/react/collapsible";
import {
  Ban,
  Check,
  ChevronRight,
  FilePen,
  FileText,
  FolderOpen,
  Globe,
  LoaderCircle,
  Search,
  SquareTerminal,
  Trash2,
  Workflow,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { fileEdits } from "./diff.ts";
import { EditDiff } from "./EditDiff.tsx";
import type { AgentActivity, TranscriptBlock } from "./model.ts";

type ToolBlock = Extract<TranscriptBlock, { kind: "tool" }>;

const field = (input: unknown, key: string): string | undefined => {
  const value =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : undefined;
};

const baseName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

/** The files a patch touches: Codex reports its changes, Muse passes the patch text itself. */
const patchedFiles = (input: unknown): ReadonlyArray<string> => {
  const changes =
    typeof input === "object" && input !== null ? (input as { changes?: unknown }).changes : undefined;
  if (Array.isArray(changes)) return changes.flatMap((change) => field(change, "path") ?? []);
  const patch = field(input, "patch") ?? (typeof input === "string" ? input : "");
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

/** Each harness's built-in tools by what they do: Claude Code, Codex, Muse Code and Cursor name them differently. */
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
  Grep: "search",
  Glob: "search",
  grep: "search",
  glob: "search",
  semSearch: "search",
  ls: "list",
  list_dir: "list",
  Bash: "run",
  PowerShell: "run",
  shell: "run",
  exec_command: "run",
  WebFetch: "fetch",
  webFetch: "fetch",
  WebSearch: "webSearch",
  webSearch: "webSearch",
  web_search: "webSearch",
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
    case "run":
      return { icon: SquareTerminal, verb: "Run", detail: field(input, "command") ?? "", mono: true };
    case "fetch":
      return { icon: Globe, verb: "Fetch", detail: field(input, "url") ?? "" };
    case "webSearch":
      return { icon: Globe, verb: "Search the web", detail: field(input, "query") ?? "" };
    default: {
      const [, server, name] = /^mcp__(.+?)__(.+)$/.exec(tool.toolName) ?? [];
      return server && name
        ? { icon: Workflow, verb: name.replaceAll("_", " "), detail: server }
        : { icon: Wrench, verb: tool.toolName };
    }
  }
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
  return [
    read.size > 0 && count(read.size, "file", "files", "read"),
    calls.search > 0 && count(calls.search, "search", "searches"),
    calls.list > 0 && count(calls.list, "folder", "folders", "listed"),
    calls.fetch > 0 && count(calls.fetch, "page", "pages", "fetched"),
    calls.webSearch > 0 && count(calls.webSearch, "web search", "web searches"),
    edited.size > 0 && count(edited.size, "file", "files", "edited"),
    deleted.size > 0 && count(deleted.size, "file", "files", "deleted"),
    calls.run > 0 && count(calls.run, "command", "commands", "run"),
    calls.other > 0 && count(calls.other, "other tool", "other tools", "used"),
  ]
    .filter((part) => part !== false)
    .join(", ");
};

/**
 * The steps between two of the agent's messages, folded to one line that counts what they did.
 * Open while the agent is still on them, so live progress stays visible; it folds once the agent
 * moves on, unless the reader has opened or closed it themselves.
 */
export function ToolRun({
  tools,
  live,
  activity,
  children,
}: {
  tools: ReadonlyArray<ToolBlock>;
  live: boolean;
  activity: AgentActivity;
  children: ReactNode;
}) {
  const [toggled, setToggled] = useState<boolean>();
  const failed = tools.filter((tool) => tool.status === "error").length;
  const interrupted = tools.filter((tool) => tool.status === "running" && activity !== "running").length;
  return (
    <Collapsible.Root open={toggled ?? live} onOpenChange={setToggled}>
      <Collapsible.Trigger className="group flex max-w-full items-center gap-1.5 text-left text-[12.5px] text-fg-tertiary transition-colors hover:text-fg-secondary">
        <Wrench size={13} strokeWidth={1.75} className="shrink-0" />
        <span className="min-w-0 truncate">{summarizeTools(tools)}</span>
        {failed > 0 ? <span className="shrink-0 text-error">· {failed} failed</span> : null}
        {interrupted > 0 ? <span className="shrink-0">· {interrupted} interrupted</span> : null}
        <ChevronRight
          size={13}
          className="shrink-0 transition-transform duration-200 group-data-panel-open:rotate-90"
        />
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0">
        <div className="flex flex-col gap-3 pt-2.5">{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** Consecutive tool calls, shown as one activity card with a row per call. */
export function ToolGroup({ tools, activity }: { tools: ReadonlyArray<ToolBlock>; activity: AgentActivity }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line-subtle">
      {tools.map((tool, index) => (
        <ToolRow key={tool.id} tool={tool} divider={index > 0} activity={activity} />
      ))}
    </div>
  );
}

function ToolRow({
  tool,
  divider,
  activity,
}: {
  tool: ToolBlock;
  divider: boolean;
  activity: AgentActivity;
}) {
  const { icon: Icon, verb, detail, mono } = describeTool(tool);
  return (
    <Collapsible.Root className={divider ? "border-t border-line-subtle" : ""}>
      <Collapsible.Trigger className="group flex h-7 w-full items-center gap-2 px-2.5 text-left text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary">
        <Icon size={13} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
        <span className="shrink-0 font-medium text-fg-primary capitalize">{verb}</span>
        {detail ? (
          <span className={`min-w-0 truncate text-fg-tertiary ${mono ? "font-mono text-[11.5px]" : ""}`}>
            {detail}
          </span>
        ) : null}
        {tool.changedFiles.length > 0 ? (
          <span className="shrink-0 rounded border border-line-subtle px-1.5 text-2xs text-fg-secondary">
            {tool.changedFiles.length === 1 ? "1 file" : `${tool.changedFiles.length} files`}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <ToolStatus status={tool.status} activity={activity} />
          <ChevronRight
            size={13}
            className="text-fg-tertiary opacity-0 transition-[opacity,rotate] duration-200 group-hover:opacity-100 group-data-panel-open:rotate-90 group-data-panel-open:opacity-100"
          />
        </span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0">
        <div className="flex flex-col gap-2 px-3 pt-1 pb-3">
          {fileEdits(tool.input).length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="text-2xs font-medium tracking-wide text-fg-tertiary uppercase">Change</span>
              <EditDiff edits={fileEdits(tool.input)} />
            </div>
          ) : (
            <Payload label="Input" value={tool.input} />
          )}
          {tool.output === undefined ? null : <Payload label="Output" value={tool.output} />}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function ToolStatus({ status, activity }: { status: ToolBlock["status"]; activity: AgentActivity }) {
  // A call still open after its agent's turn ended was cut off, not slow.
  if (status === "running" && activity !== "running") {
    return (
      <span className="flex items-center gap-1 text-2xs text-fg-tertiary">
        <Ban size={11} strokeWidth={2} />
        Interrupted
      </span>
    );
  }
  if (status === "running") return <LoaderCircle size={13} className="animate-spin text-running" />;
  if (status === "error") return <X size={13} strokeWidth={2.25} className="text-error" />;
  return <Check size={13} strokeWidth={2.25} className="text-success/80" />;
}

function Payload({ label, value }: { label: string; value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs font-medium tracking-wide text-fg-tertiary uppercase">{label}</span>
      <pre className="max-h-48 overflow-auto rounded-lg border border-line-subtle bg-surface-window px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-fg-secondary select-text">
        {text}
      </pre>
    </div>
  );
}
