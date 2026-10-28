import { Collapsible } from "@base-ui/react/collapsible";
import {
  Ban,
  ChevronRight,
  Copy,
  ExternalLink,
  FolderOpen,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";
import { memo, useContext, useState, type ReactNode } from "react";

import { shellBridge } from "../../backend/shell.ts";
import {
  FileImageThumb,
  ImageThumb,
  MissingImage,
  ToolOutputImageThumb,
} from "../../components/ImageThumb.tsx";
import { ContextMenuArea, MenuItem, MenuSeparator } from "../../components/ui/Menu.tsx";
import { useArrivals, useChanged } from "../../lib/motion.ts";
import { CopyButton } from "./CopyButton.tsx";
import { EditDiff, editCounts } from "./EditDiff.tsx";
import { WorkspaceFolder } from "./FileChip.tsx";
import type { AgentActivity } from "./model.ts";
import { resolvePath } from "./paths.ts";
import { STEP_HEADER, StepChevron, Took, TraceNode } from "./Trace.tsx";
import {
  describeTool,
  exitCodeOf,
  failureLine,
  hasToolMenu,
  outputText,
  sameTool,
  shownImages,
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
  if (image.removed) {
    return full ? (
      <MissingImage title="Screenshots go from threads quiet for a while (Settings → General)">
        {image.name} removed
      </MissingImage>
    ) : null;
  }
  if (image.url) {
    return (
      <ImageThumb
        url={image.url}
        name={image.name}
        galleryKey={image.key}
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
        galleryKey={image.key}
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
        galleryKey={image.key}
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

/** When a step began and ended; absent from a step written before the transcript kept time. */
export interface Timing {
  readonly startedAt?: number | undefined;
  readonly endedAt?: number | undefined;
}

/**
 * The steps between two of the agent's messages, folded to one line that counts what they did and
 * how long they took. Open while the agent is still on them, so live progress stays visible; it
 * folds once the agent moves on, unless the reader has opened or closed it themselves. Opened, the
 * steps show as a trace (Trace.tsx).
 */
export function ToolRun({
  tools,
  timings,
  live,
  activity,
  arrived = false,
  children,
}: {
  tools: ReadonlyArray<ToolBlock>;
  /** Each step's, its thoughts' as well as its calls'. */
  timings: ReadonlyArray<Timing>;
  live: boolean;
  activity: AgentActivity;
  /** The run came in while the thread was open, so its line writes itself in. */
  arrived?: boolean;
  children: ReactNode;
}) {
  const [toggled, setToggled] = useState<boolean>();
  const failed = tools.filter((tool) => tool.status === "error").length;
  const interrupted = tools.filter((tool) => tool.status === "running" && activity !== "running").length;
  const images = tools.flatMap(shownImages);
  const open = toggled ?? live;
  const previewed = images.length <= PREVIEWED ? images : images.slice(0, PREVIEWED - 1);
  const starts = timings.flatMap((step) => (step.startedAt === undefined ? [] : [step.startedAt]));
  const ends = timings.flatMap((step) => (step.endedAt === undefined ? [] : [step.endedAt]));
  // A run its agent is still on keeps counting; one it left off lasted until its last step ended.
  const running = live && ends.length < timings.length;
  return (
    <Collapsible.Root open={open} onOpenChange={setToggled}>
      <Collapsible.Trigger
        className={`group flex max-w-full min-w-0 items-center gap-2 text-left text-meta text-fg-tertiary transition-colors hover:text-fg-secondary max-md:py-1 ${arrived ? "write-in" : ""}`}
      >
        <Strip tools={tools} activity={activity} />
        <span className="flex min-w-0">
          <span className="min-w-0 truncate">{summarizeTools(tools)}</span>
          {failed > 0 ? (
            <span className="shrink-0 whitespace-pre">
              , <span className="text-error-text">{failed} failed</span>
            </span>
          ) : null}
          {interrupted > 0 ? (
            <span className="shrink-0 whitespace-pre">, {interrupted} interrupted</span>
          ) : null}
        </span>
        {starts.length > 0 && (running || ends.length > 0) ? (
          <Took
            startedAt={Math.min(...starts)}
            endedAt={running ? undefined : Math.max(...ends)}
            className="text-meta"
          />
        ) : null}
        <ChevronRight
          size={13}
          className="-ml-0.5 shrink-0 transition-transform duration-200 group-data-panel-open:rotate-90"
        />
      </Collapsible.Trigger>
      {/* Folded, the images the agent looked at stay in sight; open, each shows with its call. */}
      {images.length > 0 && !open ? (
        <div className="flex gap-1.5 pt-2">
          {previewed.map((image) => (
            <ToolImageThumb key={image.key} image={image} />
          ))}
          {images.length > previewed.length ? (
            <button
              type="button"
              onClick={() => setToggled(true)}
              aria-label={`Show all ${images.length} images`}
              className={`${PREVIEW} grid shrink-0 place-items-center border border-line-subtle text-meta text-fg-secondary tabular-nums transition-colors hover:bg-surface-hover hover:text-fg-primary`}
            >
              +{images.length - previewed.length}
            </button>
          ) : null}
        </div>
      ) : null}
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0">
        <div data-trace className="flex flex-col pt-1.5">
          {children}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** A run's calls in order, a tick each in the colour of how it went: the run's shape at a glance. */
function Strip({ tools, activity }: { tools: ReadonlyArray<ToolBlock>; activity: AgentActivity }) {
  return (
    <span aria-hidden className="flex h-3 w-max max-w-16 shrink-0 items-stretch gap-px">
      {tools.map((tool) => (
        <span
          key={tool.id}
          className={`max-w-[3px] min-w-px flex-[1_1_3px] rounded-full ${
            tool.status === "error"
              ? "bg-error-text"
              : tool.status === "done"
                ? "bg-fg-tertiary/55"
                : activity === "running"
                  ? "animate-pulse bg-running-text"
                  : "bg-line-strong"
          }`}
        />
      ))}
    </span>
  );
}

/**
 * Consecutive tool calls, a step of the trace each. The group and each row render again only when
 * their calls changed: while the agent works, every streamed word and every call lays its run out
 * afresh.
 */
export const ToolGroup = memo(
  function ToolGroup({ tools, activity }: { tools: ReadonlyArray<ToolBlock>; activity: AgentActivity }) {
    // A call made while the run is in view writes its row in under the ones before it.
    const arrived = useArrivals(tools.map((tool) => tool.id));
    return (
      <div>
        {tools.map((tool) => (
          <ToolRow key={tool.id} tool={tool} activity={activity} arrived={arrived(tool.id)} />
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
    activity,
    arrived,
  }: {
    tool: ToolBlock;
    activity: AgentActivity;
    arrived: boolean;
  }) {
    const [open, setOpen] = useState(false);
    const { icon, verb, detail, mono } = describeTool(tool);
    const input = toolInputView(tool);
    const counts = input?.kind === "diff" ? editCounts(input.edits) : undefined;
    const interrupted = tool.status === "running" && activity !== "running";
    // A failed call says why on its row, so a folded run opens onto what went wrong.
    const reason = tool.status === "error" ? failureLine(tool.output) : undefined;
    const header = (
      <Collapsible.Trigger className={STEP_HEADER}>
        <span className="flex h-7 w-full items-center gap-2 px-1.5 max-md:h-9">
          <span className="shrink-0 font-medium text-fg-secondary transition-colors group-hover/step:text-fg-primary">
            {verb}
          </span>
          {detail ? (
            <span className={`min-w-0 truncate text-fg-tertiary ${mono ? "font-mono text-meta" : ""}`}>
              {detail}
            </span>
          ) : null}
          {counts ? (
            <span className="flex shrink-0 gap-1 text-caption tabular-nums">
              {counts.added > 0 ? <span className="text-success-text">+{counts.added}</span> : null}
              {counts.removed > 0 ? <span className="text-error-text">−{counts.removed}</span> : null}
            </span>
          ) : tool.changedFiles.length > 0 ? (
            <span className="shrink-0 text-caption text-fg-tertiary">
              {tool.changedFiles.length === 1
                ? "1 file changed"
                : `${tool.changedFiles.length} files changed`}
            </span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {interrupted ? (
              <span className="text-caption text-fg-tertiary">Interrupted</span>
            ) : tool.status === "running" || tool.endedAt !== undefined ? (
              <Took startedAt={tool.startedAt} endedAt={tool.endedAt} />
            ) : null}
            <StepChevron />
          </span>
        </span>
        {reason && !open ? (
          <span className="block w-full truncate px-1.5 pb-1.5 text-meta text-error-text">{reason}</span>
        ) : null}
      </Collapsible.Trigger>
    );
    return (
      <Collapsible.Root
        data-row
        open={open}
        onOpenChange={setOpen}
        className={`flex ${arrived ? "write-in" : ""}`}
      >
        <TraceNode>
          <ToolNode icon={icon} status={tool.status} interrupted={interrupted} />
        </TraceNode>
        <div className="min-w-0 flex-1">
          {hasToolMenu(tool) ? (
            <ContextMenuArea menu={<ToolMenu tool={tool} />}>{header}</ContextMenuArea>
          ) : (
            header
          )}
          <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0">
            <ToolBody tool={tool} />
          </Collapsible.Panel>
        </div>
      </Collapsible.Root>
    );
  },
  (before, after) =>
    before.activity === after.activity &&
    before.arrived === after.arrived &&
    sameTool(before.tool, after.tool),
);

/**
 * A call's node on the trace: what kind of call it is, or while it runs a spinner. A failed call's
 * icon turns the error's colour; one cut off when its agent's turn ended shows it was stopped.
 */
function ToolNode({
  icon: Icon,
  status,
  interrupted,
}: {
  icon: LucideIcon;
  status: ToolBlock["status"];
  interrupted: boolean;
}) {
  // A call seen finishing pops its icon in where the spinner turned.
  const finished = useChanged(status);
  if (interrupted) return <Ban size={12} strokeWidth={2} className="text-fg-tertiary" />;
  if (status === "running") return <LoaderCircle size={13} className="animate-spin text-running-text" />;
  return (
    <Icon
      size={13}
      strokeWidth={1.75}
      className={`${status === "error" ? "text-error-text" : "text-fg-tertiary"} ${finished ? "swap-in" : ""}`}
    />
  );
}

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

/** What an opened row shows: what the call was given, then what came back. */
function ToolBody({ tool }: { tool: ToolBlock }) {
  const input = toolInputView(tool);
  const images = toolImages(tool);
  const output = tool.output === undefined ? "" : outputText(tool.output);
  const exit = exitCodeOf(output);
  const shown = exit === undefined ? output : withoutExitLine(output);
  const failed = tool.status === "error";
  // An edit that went through says so in its own words ("The file has been updated"); its diff
  // already shows what it did.
  const said = input?.kind === "diff" && !failed;
  const isCommand = input?.kind === "code" && input.label === "Command";
  // A short command the row already shows whole needs no second copy.
  const { detail } = describeTool(tool);
  const saidAbove = isCommand && detail === input.text && input.text.length <= SHORT_COMMAND;
  return (
    <div className="flex flex-col gap-2 pt-1 pr-1.5 pb-3 pl-2">
      {input?.kind === "diff" ? (
        <Frame label="Change">
          <EditDiff edits={input.edits} bare />
        </Frame>
      ) : input?.kind === "code" ? (
        saidAbove ? null : (
          <Pane label={input.label} text={input.text} />
        )
      ) : input?.kind === "subject" ? (
        <p className="font-mono text-meta leading-relaxed break-all text-fg-tertiary select-text">
          {input.text}
        </p>
      ) : null}
      {images.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {images.map((image) => (
            <ToolImageThumb key={image.key} image={image} full />
          ))}
        </div>
      ) : null}
      {said ? null : shown !== "" || exit !== undefined ? (
        <Pane
          label="Output"
          text={shown}
          failed={failed}
          badge={exit === undefined ? undefined : `Exit ${exit}`}
        />
      ) : isCommand && tool.status === "done" && images.length === 0 ? (
        <p className="text-meta text-fg-tertiary">No output</p>
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
  const controls =
    folds || clipped ? (
      <>
        {folds ? (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            className="-mx-1 rounded px-1 py-1.5 transition-colors hover:text-fg-primary max-md:py-2.5"
          >
            {expanded ? "Show fewer lines" : `Show ${hidden} ${failed ? "earlier" : "more"} lines`}
          </button>
        ) : null}
        {clipped && (expanded || !folds) ? (
          <span className="py-1.5">Cut at {MAX_CHARACTERS.toLocaleString("en-US")} characters</span>
        ) : null}
      </>
    ) : null;
  // A failure's earlier lines are above what it shows, so its controls sit in the header; the rest
  // of a long output is below, so its controls sit under it.
  return (
    <Frame
      label={label}
      badge={badge}
      failed={failed}
      copy={text === "" ? undefined : text}
      aside={failed ? controls : null}
    >
      {text === "" ? null : (
        <>
          <pre
            className={`scroll-thin overflow-auto px-3 pb-2 font-mono text-meta leading-relaxed break-words whitespace-pre-wrap text-fg-secondary select-text ${expanded ? "max-h-80" : ""}`}
          >
            {shown}
          </pre>
          {!failed && controls ? (
            <div className="flex items-center gap-3 border-t border-line-subtle px-3 text-caption text-fg-tertiary">
              {controls}
            </div>
          ) : null}
        </>
      )}
    </Frame>
  );
}

/**
 * The recessed card a call's input or output sits in, as a reply's code blocks do: what it holds
 * named in its header, with a copy button beside it on hover.
 */
function Frame({
  label,
  badge,
  failed = false,
  copy,
  aside = null,
  children,
}: {
  label: string;
  badge?: string | undefined;
  failed?: boolean;
  copy?: string | undefined;
  /** Controls at the header's end, before the copy button. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={`group/pane overflow-hidden rounded-lg border bg-surface-sunken ${failed ? "border-error/25" : "border-line-subtle"}`}
    >
      <div className="flex h-7 items-center gap-2 pr-1 pl-3 text-caption text-fg-tertiary">
        <span>{label}</span>
        {badge ? (
          <span
            className={`rounded px-1.5 tabular-nums ${failed ? "bg-error/12 text-error-text" : "bg-surface-hover text-fg-secondary"}`}
          >
            {badge}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-3">
          {aside}
          {copy === undefined ? null : (
            <CopyButton
              text={copy}
              label={`Copy ${label.toLowerCase()}`}
              className="opacity-0 group-focus-within/pane:opacity-100 group-hover/pane:opacity-100 pointer-coarse:opacity-100"
            />
          )}
        </span>
      </div>
      {children}
    </div>
  );
}
