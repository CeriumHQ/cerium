import { Collapsible } from "@base-ui/react/collapsible";
import {
  Ban,
  Check,
  ChevronRight,
  FilePen,
  FileText,
  Globe,
  LoaderCircle,
  Search,
  SquareTerminal,
  Workflow,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";

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

/** A verb, an icon and the one detail that identifies what a tool call did. */
export const describeTool = (
  tool: ToolBlock,
): {
  readonly icon: LucideIcon;
  readonly verb: string;
  readonly detail?: string;
  readonly mono?: boolean;
} => {
  const path = field(tool.input, "file_path") ?? field(tool.input, "path");
  switch (tool.toolName) {
    case "Read":
      return { icon: FileText, verb: "Read", ...(path ? { detail: baseName(path) } : {}) };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return {
        icon: FilePen,
        verb: tool.toolName === "Write" ? "Write" : "Edit",
        ...(path ? { detail: baseName(path) } : {}),
      };
    case "Grep":
    case "Glob":
      return { icon: Search, verb: "Search", detail: field(tool.input, "pattern") ?? "", mono: true };
    case "Bash":
    case "PowerShell":
      return { icon: SquareTerminal, verb: "Run", detail: field(tool.input, "command") ?? "", mono: true };
    case "WebFetch":
    case "WebSearch":
      return {
        icon: Globe,
        verb: tool.toolName === "WebFetch" ? "Fetch" : "Search the web",
        detail: field(tool.input, "url") ?? field(tool.input, "query") ?? "",
      };
    default: {
      const [, server, name] = /^mcp__(.+?)__(.+)$/.exec(tool.toolName) ?? [];
      return server && name
        ? { icon: Workflow, verb: name.replaceAll("_", " "), detail: server }
        : { icon: Wrench, verb: tool.toolName };
    }
  }
};

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
