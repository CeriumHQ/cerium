import { Collapsible } from "@base-ui/react/collapsible";
import {
  Ban,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
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
import { useContext, useState, type ReactNode } from "react";

import { shellBridge } from "../../backend/shell.ts";
import { FileImageThumb, ImageThumb } from "../../components/ImageThumb.tsx";
import { ContextMenuArea, MenuItem, MenuSeparator } from "../../components/ui/Menu.tsx";
import { fileEdits } from "./diff.ts";
import { EditDiff } from "./EditDiff.tsx";
import { WorkspaceFolder } from "./FileChip.tsx";
import type { AgentActivity, TranscriptBlock } from "./model.ts";
import { resolvePath } from "./paths.ts";

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

/** Long base64 (an image in a tool's output) shows as its size instead of a wall of characters. */
const withoutBlobs = (_key: string, value: unknown) =>
  typeof value === "string" && value.length > 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(value.slice(-64))
    ? `[${Math.round((value.length * 3) / 4 / 1024)} KB of base64]`
    : value;

const payloadText = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, withoutBlobs, 2);

/** What a tool call's menu copies and opens, by the kind of tool; anything unplaced copies its input. */
export const toolMenuPlan = (tool: ToolBlock): ToolMenuPlan => {
  const { input } = tool;
  const path = field(input, "file_path") ?? field(input, "path");
  const copyInput = (): Pick<ToolMenuPlan, "copy"> =>
    input === undefined ? {} : { copy: { label: "Copy input", text: payloadText(input) } };
  // The Output panel gives way to the images a call showed, so there is no text to copy then.
  const output =
    tool.output === undefined || toolImages(tool).length > 0 ? {} : { output: payloadText(tool.output) };
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

/** An image a tool call showed the agent: its bytes from the call's output, or the file it read. */
export interface ToolImage {
  readonly key: string;
  readonly name: string;
  /** A data URL, when the output carried the image itself. */
  readonly url?: string;
  /** An absolute path the backend can read, otherwise. */
  readonly path?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Base64 images in a tool's output, as Anthropic content blocks or MCP content items carry them. */
const outputImages = (
  output: unknown,
): ReadonlyArray<{ readonly mediaType: string; readonly data: string }> => {
  const found: Array<{ mediaType: string; data: string }> = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 4) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    if (value["type"] === "image") {
      const source = isRecord(value["source"]) ? value["source"] : value;
      const data = source["data"];
      const mediaType = source["media_type"] ?? source["mediaType"] ?? source["mimeType"];
      if (typeof data === "string" && typeof mediaType === "string" && mediaType.startsWith("image/")) {
        found.push({ mediaType, data });
        return;
      }
    }
    for (const key of ["content", "output", "result"]) visit(value[key], depth + 1);
  };
  visit(output, 0);
  return found;
};

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i;
const ABSOLUTE = /^(?:[a-z]:[\\/]|[\\/])/i;

/** The images a tool call showed the agent, such as a screenshot it read or one a tool returned. */
export const toolImages = (tool: ToolBlock): ReadonlyArray<ToolImage> => {
  const path = field(tool.input, "file_path") ?? field(tool.input, "path");
  const name = path ? baseName(path) : "Image";
  const inline = outputImages(tool.output);
  if (inline.length > 0) {
    return inline.map((image, index) => ({
      key: `${tool.id}:${index}`,
      name: inline.length === 1 ? name : `${name} (${index + 1})`,
      url: `data:${image.mediaType};base64,${image.data}`,
    }));
  }
  // Harnesses that only report the path: the file is read again to show it.
  const saved = field(tool.output, "savedPath");
  const file = toolKinds[tool.toolName] === "read" || tool.toolName === "view_image" ? path : saved;
  if (tool.status === "done" && file && IMAGE_FILE.test(file) && ABSOLUTE.test(file)) {
    return [{ key: tool.id, name: baseName(file), path: file }];
  }
  return [];
};

function ToolImageThumb({ image, className }: { image: ToolImage; className: string }) {
  if (image.url) return <ImageThumb url={image.url} name={image.name} className={className} menu />;
  if (image.path) return <FileImageThumb path={image.path} name={image.name} className={className} />;
  return null;
}

/** How many images a folded run previews before counting the rest. */
const PREVIEWED = 3;

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
  const images = tools.flatMap(toolImages);
  const open = toggled ?? live;
  return (
    <Collapsible.Root open={open} onOpenChange={setToggled}>
      <div className="flex min-w-0 items-center gap-3">
        <Collapsible.Trigger className="group flex max-w-full min-w-0 items-center gap-1.5 text-left text-[12.5px] text-fg-tertiary transition-colors hover:text-fg-secondary">
          <Wrench size={13} strokeWidth={1.75} className="shrink-0" />
          <span className="min-w-0 truncate">{summarizeTools(tools)}</span>
          {failed > 0 ? <span className="shrink-0 text-error">· {failed} failed</span> : null}
          {interrupted > 0 ? <span className="shrink-0">· {interrupted} interrupted</span> : null}
          <ChevronRight
            size={13}
            className="shrink-0 transition-transform duration-200 group-data-panel-open:rotate-90"
          />
        </Collapsible.Trigger>
        {/* Folded, the images the agent looked at stay in sight; open, each shows with its call. */}
        {images.length > 0 && !open ? (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {images.length > PREVIEWED ? (
              <span className="pr-0.5 text-2xs text-fg-tertiary tabular-nums">
                +{images.length - PREVIEWED}
              </span>
            ) : null}
            {images.slice(0, PREVIEWED).map((image) => (
              <ToolImageThumb key={image.key} image={image} className="h-6 w-8 rounded-md" />
            ))}
          </div>
        ) : null}
      </div>
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
  const images = toolImages(tool);
  const plan = toolMenuPlan(tool);
  const folder = useContext(WorkspaceFolder);
  const reveal = shellBridge()?.revealPath;
  const location = plan.path ? resolvePath(plan.path, folder) : undefined;
  const menu = (
    <>
      {plan.copy ? (
        <MenuItem icon={Copy} onClick={() => void navigator.clipboard.writeText(location ?? plan.copy!.text)}>
          {plan.copy.label}
        </MenuItem>
      ) : null}
      {reveal && location ? (
        <MenuItem icon={FolderOpen} onClick={() => void reveal(location)}>
          Show in File Explorer
        </MenuItem>
      ) : null}
      {plan.url ? (
        <MenuItem icon={ExternalLink} onClick={() => window.open(plan.url, "_blank", "noopener,noreferrer")}>
          Open in browser
        </MenuItem>
      ) : null}
      {plan.output !== undefined ? (
        <>
          {plan.copy ? <MenuSeparator /> : null}
          <MenuItem icon={Copy} onClick={() => void navigator.clipboard.writeText(plan.output!)}>
            Copy output
          </MenuItem>
        </>
      ) : null}
    </>
  );
  const header = (
    <Collapsible.Trigger className="group flex h-7 w-full items-center gap-2 px-2.5 text-left text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary data-popup-open:bg-surface-hover data-popup-open:text-fg-primary">
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
  );
  return (
    <Collapsible.Root className={divider ? "border-t border-line-subtle" : ""}>
      {plan.copy || plan.output !== undefined ? (
        <ContextMenuArea menu={menu}>{header}</ContextMenuArea>
      ) : (
        header
      )}
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
          {images.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="text-2xs font-medium tracking-wide text-fg-tertiary uppercase">
                {images.length === 1 ? "Image" : "Images"}
              </span>
              <div className="flex flex-wrap gap-2">
                {images.map((image) => (
                  <ToolImageThumb key={image.key} image={image} className="h-40 max-w-full min-w-24" />
                ))}
              </div>
            </div>
          ) : tool.output === undefined ? null : (
            <Payload label="Output" value={tool.output} />
          )}
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
  const text = payloadText(value);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs font-medium tracking-wide text-fg-tertiary uppercase">{label}</span>
      <pre className="max-h-48 overflow-auto rounded-lg border border-line-subtle bg-surface-window px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-fg-secondary select-text">
        {text}
      </pre>
    </div>
  );
}
