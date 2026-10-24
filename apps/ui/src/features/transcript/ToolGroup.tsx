import { Collapsible } from "@base-ui/react/collapsible";
import {
  Ban,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  FolderOpen,
  LoaderCircle,
  Wrench,
  X,
} from "lucide-react";
import { memo, useContext, useState, type ReactNode } from "react";

import { shellBridge } from "../../backend/shell.ts";
import { FileImageThumb, ImageThumb, ToolOutputImageThumb } from "../../components/ImageThumb.tsx";
import { ContextMenuArea, MenuItem, MenuSeparator } from "../../components/ui/Menu.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { EditDiff } from "./EditDiff.tsx";
import { WorkspaceFolder } from "./FileChip.tsx";
import type { AgentActivity } from "./model.ts";
import { resolvePath } from "./paths.ts";
import {
  describeTool,
  exitCodeOf,
  failureLine,
  hasToolMenu,
  outputText,
  sameTool,
  summarizeTools,
  toolImages,
  toolInputView,
  toolMenuPlan,
  withoutExitLine,
  type ToolBlock,
  type ToolImage,
} from "./tools.ts";

/** A tool image's thumbnail: big enough to tell one screenshot from another, small enough to stay out of the way. */
const PREVIEW = "h-12 w-19 rounded-md md:h-16 md:w-26";

/** Shown with its own call, where there's room to see what the image holds. */
const FULL = "h-40 max-w-full min-w-24";

function ToolImageThumb({ image, full = false }: { image: ToolImage; full?: boolean }) {
  const className = full ? FULL : PREVIEW;
  if (image.url) {
    return (
      <ImageThumb
        url={image.url}
        name={image.name}
        className={className}
        fit={full ? "natural" : "crop"}
        menu
      />
    );
  }
  if (image.ref) {
    return (
      <ToolOutputImageThumb
        imageRef={image.ref}
        name={image.name}
        className={className}
        fit={full ? "natural" : "crop"}
        quiet={!full}
      />
    );
  }
  // A file that has gone since the agent looked at it leaves nothing to preview.
  if (image.path) {
    return (
      <FileImageThumb
        path={image.path}
        name={image.name}
        className={className}
        fit={full ? "natural" : "crop"}
        quiet={!full}
      />
    );
  }
  return null;
}

/** How many images a folded run previews: all of them up to this many, otherwise one fewer and a count. */
const PREVIEWED = 4;

const LABEL = "text-2xs font-medium tracking-wide text-fg-tertiary uppercase";

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
  const previewed = images.length <= PREVIEWED ? images : images.slice(0, PREVIEWED - 1);
  return (
    <Collapsible.Root open={open} onOpenChange={setToggled}>
      <Collapsible.Trigger className="group flex max-w-full min-w-0 items-center gap-1.5 text-left text-[12.5px] text-fg-tertiary transition-colors hover:text-fg-secondary max-md:py-1">
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
        <div className="flex gap-1.5 pt-2 pl-[19px]">
          {previewed.map((image) => (
            <ToolImageThumb key={image.key} image={image} />
          ))}
          {images.length > previewed.length ? (
            <button
              type="button"
              onClick={() => setToggled(true)}
              aria-label={`Show all ${images.length} images`}
              className={`${PREVIEW} grid shrink-0 place-items-center border border-line-subtle text-xs text-fg-secondary tabular-nums transition-colors hover:bg-surface-hover hover:text-fg-primary`}
            >
              +{images.length - previewed.length}
            </button>
          ) : null}
        </div>
      ) : null}
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0">
        <div className="flex flex-col gap-3 pt-2.5">{children}</div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/**
 * Consecutive tool calls, shown as one activity card with a row per call. The card and each row
 * render again only when their calls changed: while the agent works, every streamed word and every
 * call lays its run out afresh.
 */
export const ToolGroup = memo(
  function ToolGroup({ tools, activity }: { tools: ReadonlyArray<ToolBlock>; activity: AgentActivity }) {
    return (
      <div className="overflow-hidden rounded-lg border border-line-subtle">
        {tools.map((tool, index) => (
          <ToolRow key={tool.id} tool={tool} divider={index > 0} activity={activity} />
        ))}
      </div>
    );
  },
  (before, after) =>
    before.activity === after.activity &&
    before.tools.length === after.tools.length &&
    before.tools.every((tool, index) => sameTool(tool, after.tools[index]!)),
);

const ToolRow = memo(
  function ToolRow({
    tool,
    divider,
    activity,
  }: {
    tool: ToolBlock;
    divider: boolean;
    activity: AgentActivity;
  }) {
    const [open, setOpen] = useState(false);
    const { icon: Icon, verb, detail, mono } = describeTool(tool);
    // A failed call says why on its row, so a folded run opens onto what went wrong.
    const reason = tool.status === "error" ? failureLine(tool.output) : undefined;
    const header = (
      <Collapsible.Trigger className="group block w-full text-left text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary data-popup-open:bg-surface-hover data-popup-open:text-fg-primary">
        <span className="flex h-7 items-center gap-2 px-2.5 max-md:h-9">
          <Icon size={13} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
          <span className="shrink-0 font-medium text-fg-primary">{verb}</span>
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
              className="text-fg-tertiary opacity-0 transition-[opacity,rotate] duration-200 group-hover:opacity-100 group-data-panel-open:rotate-90 group-data-panel-open:opacity-100 pointer-coarse:opacity-100"
            />
          </span>
        </span>
        {reason && !open ? (
          <span className="block truncate pr-3 pb-1.5 pl-[31px] text-[12px] text-error">{reason}</span>
        ) : null}
      </Collapsible.Trigger>
    );
    return (
      <Collapsible.Root
        open={open}
        onOpenChange={setOpen}
        className={divider ? "border-t border-line-subtle" : ""}
      >
        {hasToolMenu(tool) ? (
          <ContextMenuArea menu={<ToolMenu tool={tool} />}>{header}</ContextMenuArea>
        ) : (
          header
        )}
        <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0">
          <ToolBody tool={tool} />
        </Collapsible.Panel>
      </Collapsible.Root>
    );
  },
  (before, after) =>
    before.divider === after.divider &&
    before.activity === after.activity &&
    sameTool(before.tool, after.tool),
);

/**
 * A tool row's right-click menu. It renders only while open: what it copies includes the output laid
 * out for reading, which took most of a live run's time when every row worked it out on each update.
 */
function ToolMenu({ tool }: { tool: ToolBlock }) {
  const plan = toolMenuPlan(tool);
  const folder = useContext(WorkspaceFolder);
  const reveal = shellBridge()?.revealPath;
  const location = plan.path ? resolvePath(plan.path, folder) : undefined;
  return (
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

/** What an opened row shows: what the call was given, then what came back. */
function ToolBody({ tool }: { tool: ToolBlock }) {
  const input = toolInputView(tool);
  const images = toolImages(tool);
  const output = tool.output === undefined ? "" : outputText(tool.output);
  const exit = exitCodeOf(output);
  const shown = exit === undefined ? output : withoutExitLine(output);
  const failed = tool.status === "error";
  const isCommand = input?.kind === "code" && input.label === "Command";
  // A short command the row already shows whole needs no second copy.
  const { detail } = describeTool(tool);
  const saidAbove = isCommand && detail === input.text && input.text.length <= SHORT_COMMAND;
  return (
    <div className="flex flex-col gap-2.5 px-3 pt-1 pb-3">
      {input?.kind === "diff" ? (
        <div className="flex flex-col gap-1">
          <span className={LABEL}>Change</span>
          <EditDiff edits={input.edits} />
        </div>
      ) : input?.kind === "code" ? (
        saidAbove ? null : (
          <Pane label={input.label} text={input.text} />
        )
      ) : input?.kind === "subject" ? (
        <p className="font-mono text-[12px] leading-relaxed break-all text-fg-tertiary select-text">
          {input.text}
        </p>
      ) : null}
      {images.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className={LABEL}>{images.length === 1 ? "Image" : "Images"}</span>
          <div className="flex flex-wrap gap-2">
            {images.map((image) => (
              <ToolImageThumb key={image.key} image={image} full />
            ))}
          </div>
        </div>
      ) : null}
      {shown !== "" || exit !== undefined ? (
        <Pane
          label="Output"
          text={shown}
          failed={failed}
          badge={exit === undefined ? undefined : `Exit ${exit}`}
        />
      ) : isCommand && tool.status === "done" && images.length === 0 ? (
        <p className="text-xs text-fg-tertiary">No output</p>
      ) : null}
    </div>
  );
}

/** A command this short fits its row, so the opened row doesn't repeat it. */
const SHORT_COMMAND = 48;

/** Lines shown before a long block folds, and how few lines are worth folding. */
const FOLDED_LINES = 8;
const FOLD_SLACK = 3;
/** Past this, even the opened block stops: the rest is a copy away. */
const MAX_CHARACTERS = 60_000;

/**
 * A block of text from a tool call, with a copy button. A long one shows its first lines, or for a
 * failure its last, since that is where the error is, and says how many more there are; opened, it
 * scrolls.
 */
function Pane({
  label,
  text,
  failed = false,
  badge,
}: {
  label: string;
  text: string;
  failed?: boolean;
  /** Said beside the label, such as a command's exit code. */
  badge?: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  // A closing newline ends the last line rather than starting one more.
  const lines = text.replace(/\r?\n$/u, "").split("\n");
  const folds = lines.length > FOLDED_LINES + FOLD_SLACK;
  const clipped = text.length > MAX_CHARACTERS;
  const hidden = lines.length - FOLDED_LINES;
  // Folded or not, a few huge lines are still cut at the limit.
  const cut = (value: string) => (failed ? value.slice(-MAX_CHARACTERS) : value.slice(0, MAX_CHARACTERS));
  const shown = cut(
    folds && !expanded
      ? (failed ? lines.slice(-FOLDED_LINES) : lines.slice(0, FOLDED_LINES)).join("\n")
      : text,
  );
  const bar = (
    <div
      className={`flex items-center gap-3 border-line-subtle px-3 text-xs text-fg-tertiary ${failed ? "border-b" : "border-t"}`}
    >
      {folds ? (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          className="-ml-1 rounded px-1 py-1.5 transition-colors hover:text-fg-primary max-md:py-2.5"
        >
          {expanded ? "Show fewer lines" : `Show ${hidden} ${failed ? "earlier" : "more"} lines`}
        </button>
      ) : null}
      {clipped && (expanded || !folds) ? (
        <span className="py-1.5">Cut at {MAX_CHARACTERS.toLocaleString("en-US")} characters</span>
      ) : null}
    </div>
  );
  return (
    <div className="group/pane flex flex-col gap-1">
      <div className="flex min-h-6 items-center gap-2">
        <span className={LABEL}>{label}</span>
        {badge ? (
          <span
            className={`rounded px-1.5 text-2xs tabular-nums ${failed ? "bg-error/10 text-error" : "bg-surface-hover text-fg-secondary"}`}
          >
            {badge}
          </span>
        ) : null}
        {text === "" ? null : (
          <CopyButton
            text={text}
            label={`Copy ${label.toLowerCase()}`}
            className="ml-auto opacity-0 group-focus-within/pane:opacity-100 group-hover/pane:opacity-100 pointer-coarse:opacity-100"
          />
        )}
      </div>
      {text === "" ? null : (
        <div
          className={`overflow-hidden rounded-lg border bg-surface-window ${failed ? "border-error/30" : "border-line-subtle"}`}
        >
          {failed && (folds || clipped) ? bar : null}
          <pre
            className={`scroll-thin overflow-auto px-3 py-2 font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap text-fg-secondary select-text ${expanded ? "max-h-80" : ""}`}
          >
            {shown}
          </pre>
          {!failed && (folds || clipped) ? bar : null}
        </div>
      )}
    </div>
  );
}
