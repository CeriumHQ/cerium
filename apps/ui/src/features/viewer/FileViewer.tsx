import { Button } from "@base-ui/react/button";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { FileDiff, FilePreview as Preview } from "@cerium/rpc";
import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { Atom, AsyncResult } from "effect/reactivity";
import { Columns2, Ellipsis, FolderOpen, Rows2, SquareArrowOutUpRight, WrapText, X } from "lucide-react";
import { useContext, useEffect, useEffectEvent, type ReactNode } from "react";

import {
  changesAtom,
  diffAtom,
  diffKey,
  previewAtom,
  previewKey,
  refreshFile,
  refreshStatus,
  watchAtom,
} from "../../backend/explorer.ts";
import { shellBridge } from "../../backend/shell.ts";
import { FileIcon } from "../../components/FileIcon.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import {
  ContextMenuArea,
  MenuPopup,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/Menu.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { remember } from "../../lib/storage.ts";
import type { MessageBox } from "../composer/messageBox.ts";
import { FileMenuItems } from "../files/FileMenu.tsx";
import { diffSideAtom } from "../git/model.ts";
import { SideDiff } from "../git/SideDiff.tsx";
import { StateLetter, TouchedMark } from "../files/FileStatus.tsx";
import type { PaneChrome } from "../split/SplitView.tsx";
import { dirOf, nameOf, stateAt, stateWord, touchWord, type OpenFile } from "../files/model.ts";
import { WorkspaceFolder } from "../transcript/FileChip.tsx";
import { fileTargets } from "../transcript/menus.ts";
import { CodeView } from "./CodeView.tsx";
import { DiffView } from "./DiffView.tsx";
import {
  byteSize,
  DIFF_LAYOUT_KEY,
  diffLayoutAtom,
  diffStats,
  fileKey,
  fileViewAtom,
  pickView,
  renderedKind,
  viewsOf,
  wholeDiffAtom,
  WRAP_KEY,
  wrapAtom,
} from "./model.ts";
import { HtmlPreview, MarkdownPreview, MediaPreview, messageOf, Note, SvgPreview } from "./previews.tsx";

/** Unchanged lines asked for to show a changed file whole. */
const WHOLE_FILE = 1_000_000;
/** Unchanged lines around each change otherwise. */
const CONTEXT = 3;

/** What's read for the diff while another view shows. */
const noDiff: Atom.Atom<AsyncResult.AsyncResult<FileDiff, unknown>> = Atom.make(AsyncResult.initial());

const toggleClass =
  "rounded-md px-2 py-0.5 text-meta font-medium text-fg-tertiary transition-colors duration-150 select-none hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary max-md:px-2.5 max-md:py-1.5 max-md:text-[14px]";

const iconToggleClass =
  "grid size-7 place-items-center rounded-md text-fg-tertiary transition-colors duration-150 hover:bg-surface-hover hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary max-md:size-10";

/** A button offering a way out of a file the viewer can't show: its own app, or File Explorer. */
function OutAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof FolderOpen;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      onClick={onClick}
      className="flex h-8 items-center gap-1.5 rounded-md border border-line-strong px-3 text-meta text-fg-primary transition-colors hover:bg-surface-hover"
    >
      <Icon size={13} strokeWidth={1.75} />
      {label}
    </Button>
  );
}

function FileBody({
  root,
  path,
  preview,
  failure,
  rendered,
  wrap,
  messageBox,
  onOpenFile,
  outside,
}: {
  root: string;
  path: string;
  preview: Preview | undefined;
  failure: string | undefined;
  rendered: boolean;
  wrap: boolean;
  messageBox: MessageBox | undefined;
  onOpenFile: OpenFile | undefined;
  /** Opens the file in its own app or shows it in File Explorer, where this computer can. */
  outside: ReactNode;
}) {
  if (preview === undefined) return failure === undefined ? null : <Note>{failure}</Note>;
  switch (preview._tag) {
    case "Missing":
      return <Note>This file isn't on disk any more.</Note>;
    case "Binary":
      return (
        <Note action={outside}>
          <span className="block">This file isn't text or media Cerium can show.</span>
          <span className="mt-1 block text-meta text-fg-disabled tabular-nums">{byteSize(preview.size)}</span>
        </Note>
      );
    case "Media":
      return <MediaPreview root={root} path={path} {...preview} />;
    case "Text": {
      if (preview.text === "" && !preview.truncated) return <Note>This file is empty.</Note>;
      const kind = renderedKind(path);
      const body =
        rendered && kind === "markdown" ? (
          <MarkdownPreview
            root={root}
            path={path}
            text={preview.text}
            messageBox={messageBox}
            onOpenFile={onOpenFile}
          />
        ) : rendered && kind === "html" ? (
          <HtmlPreview text={preview.text} path={path} />
        ) : rendered && kind === "svg" ? (
          <SvgPreview text={preview.text} path={path} size={preview.size} />
        ) : (
          <CodeView text={preview.text} path={path} wrap={wrap} />
        );
      return (
        <div className="flex h-full flex-col">
          <div className="min-h-0 flex-1">{body}</div>
          {preview.truncated ? (
            <p className="shrink-0 border-t border-line-subtle px-4 py-1.5 text-meta text-fg-tertiary tabular-nums">
              Showing the first {byteSize(preview.text.length)} of {byteSize(preview.size)}
            </p>
          ) : null}
        </div>
      );
    }
  }
}

function DiffBody({
  path,
  diff,
  failure,
  from,
  renamed,
  layout,
  whole,
  onWhole,
}: {
  path: string;
  diff: FileDiff | undefined;
  failure: string | undefined;
  from: string | undefined;
  renamed: boolean;
  layout: "unified" | "split";
  whole: boolean;
  onWhole: () => void;
}) {
  if (diff === undefined) return failure === undefined ? null : <Note>{failure}</Note>;
  const { hunks, binary, truncated } = diff;
  if (binary === true) return <Note>The contents changed, and they aren't text.</Note>;
  if (hunks.length === 0) {
    return (
      <Note>
        {renamed && from !== undefined
          ? `Renamed from ${from}, contents unchanged.`
          : "Nothing differs from the last commit."}
      </Note>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <DiffView hunks={hunks} path={path} layout={layout} onExpand={whole ? undefined : onWhole} />
      </div>
      {truncated === true ? (
        <p className="shrink-0 border-t border-line-subtle px-4 py-1.5 text-meta text-fg-tertiary">
          A long diff, cut short.
        </p>
      ) : null}
    </div>
  );
}

/**
 * A work thread's file in a tab of its own, read-only and kept current as agents change it: its text
 * highlighted, its changes against the last commit (one column or side by side), Markdown, web pages
 * and SVGs as they render, images, sounds and videos.
 */
export function FileViewer({
  root,
  path,
  touch,
  messageBox,
  onOpenFile,
  onClose,
  pane,
}: {
  /** The thread's folder. */
  root: string;
  /** The file, relative to `root`. */
  path: string;
  /** What this thread's agents did to it, when they touched it. */
  touch?: "created" | "modified" | "deleted" | undefined;
  messageBox: MessageBox | undefined;
  /** Opens another of the folder's files in the viewer, as a Markdown file's links ask. */
  onOpenFile?: OpenFile | undefined;
  onClose: () => void;
  /** While it shares the main area with other panes, its header is the pane's: dragged by, with the pane's menu. */
  pane?: PaneChrome | undefined;
}) {
  const registry = useContext(RegistryContext);
  const key = fileKey(root, path);
  const [chosen, setChosen] = useAtom(fileViewAtom(key));
  const [layout, setLayout] = useAtom(diffLayoutAtom);
  const [wrap, setWrap] = useAtom(wrapAtom);
  const changes = useAtomValue(changesAtom(root));
  const state = stateAt(changes, path);
  const from = changes.files.get(path)?.from;

  const previewResult = useAtomValue(previewAtom(previewKey(root, path)));
  const preview = Option.getOrUndefined(AsyncResult.value(previewResult));
  const views = viewsOf(path, state, preview?._tag);
  const view = pickView(views, chosen);

  const [whole, setWhole] = useAtom(wholeDiffAtom(key));
  /** Opened from Source control, it shows what's staged or what isn't, rather than both against the last commit. */
  const [side, setSide] = useAtom(diffSideAtom(key));
  // Read only while it shows: each change to the file reads the diff again, which can be long.
  const diffShown = view === "diff" && side === undefined;
  const diffResult = useAtomValue(
    diffShown ? diffAtom(diffKey(root, path, from, whole ? WHOLE_FILE : CONTEXT)) : noDiff,
  );
  const diff = diffShown ? Option.getOrUndefined(AsyncResult.value(diffResult)) : undefined;

  // The machine says when the file or git's view of it changes; the viewer reads it again then.
  const onBatch = useEffectEvent(
    (batch: { paths: ReadonlyArray<string>; status: boolean; overflow?: boolean }) => {
      if (batch.overflow === true || batch.paths.includes(path)) refreshFile(registry, root, path);
      if (batch.status || batch.overflow === true) refreshStatus(registry, root);
    },
  );
  useEffect(
    () =>
      registry.subscribe(
        watchAtom(root),
        (result) => {
          if (AsyncResult.isSuccess(result)) onBatch(result.value);
        },
        { immediate: true },
      ),
    [registry, root],
  );

  const { location } = fileTargets(path, false, root);
  const bridge = shellBridge();
  const gone = state === "deleted" || preview?._tag === "Missing";
  const openOutside =
    gone || location === undefined || bridge?.openPath === undefined
      ? undefined
      : () => void bridge.openPath?.(location);
  const reveal =
    gone || location === undefined || bridge?.revealPath === undefined
      ? undefined
      : () => void bridge.revealPath?.(location);
  const outside =
    openOutside || reveal ? (
      <span className="flex flex-wrap justify-center gap-2">
        {openOutside ? (
          <OutAction icon={SquareArrowOutUpRight} label="Open in its app" onClick={openOutside} />
        ) : null}
        {reveal ? <OutAction icon={FolderOpen} label="Show in File Explorer" onClick={reveal} /> : null}
      </span>
    ) : null;

  const stats = diff ? diffStats(diff.hunks) : undefined;
  const dir = dirOf(path);
  const name = nameOf(path);
  const code = view === "file" && preview?._tag === "Text";

  const header = (
    <header
      {...pane?.grip}
      className={`flex h-10 shrink-0 items-center gap-2 border-b border-line-subtle pr-1.5 pl-3 max-md:h-12 ${pane ? "select-none" : ""}`}
    >
      <FileIcon path={path} className="size-4 shrink-0" />
      <span className="flex min-w-0 items-baseline gap-2 text-body max-md:text-[15px]">
        <span
          className={`shrink-0 font-medium ${gone ? "text-fg-tertiary line-through" : "text-fg-primary"}`}
        >
          {name}
        </span>
        {dir === "" ? null : (
          <span className="min-w-0 truncate text-meta text-fg-tertiary" title={path}>
            {dir}
          </span>
        )}
      </span>
      {state ? (
        <Tooltip label={stateWord[state]}>
          <span className="grid size-5 shrink-0 place-items-center">
            <StateLetter state={state} />
          </span>
        </Tooltip>
      ) : null}
      {touch ? (
        <Tooltip label={touchWord(touch)}>
          <span className="grid size-5 shrink-0 place-items-center">
            <TouchedMark change={touch} />
          </span>
        </Tooltip>
      ) : null}
      {stats && view === "diff" && side === undefined ? (
        <span className="shrink-0 font-mono text-meta tabular-nums">
          <span className="text-success">+{stats.added}</span>{" "}
          <span className="text-error">−{stats.removed}</span>
        </span>
      ) : null}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {view === "diff" ? (
          <ToggleGroup
            value={[layout]}
            onValueChange={(value) => {
              const next = value[0];
              if (next !== "unified" && next !== "split") return;
              setLayout(next);
              remember(DIFF_LAYOUT_KEY, next);
            }}
            aria-label="Diff layout"
            className="flex items-center max-md:hidden"
          >
            <Tooltip label="One column">
              <Toggle value="unified" aria-label="One column" className={iconToggleClass}>
                <Rows2 size={15} strokeWidth={1.75} />
              </Toggle>
            </Tooltip>
            <Tooltip label="Side by side">
              <Toggle value="split" aria-label="Side by side" className={iconToggleClass}>
                <Columns2 size={15} strokeWidth={1.75} />
              </Toggle>
            </Tooltip>
          </ToggleGroup>
        ) : code ? (
          <Tooltip label="Wrap lines">
            <Toggle
              pressed={wrap}
              onPressedChange={(pressed) => {
                setWrap(pressed);
                remember(WRAP_KEY, pressed ? "on" : "off");
              }}
              aria-label="Wrap lines"
              className={iconToggleClass}
            >
              <WrapText size={15} strokeWidth={1.75} />
            </Toggle>
          </Tooltip>
        ) : null}
        {views.length > 1 ? (
          <ToggleGroup
            value={[view]}
            onValueChange={(value) => {
              const next = views.find((each) => each.value === value[0]);
              if (next) setChosen(next.value);
            }}
            aria-label="View"
            className="ml-1 flex items-center"
          >
            {views.map((each) => (
              <Toggle key={each.value} value={each.value} className={toggleClass}>
                {each.label}
              </Toggle>
            ))}
          </ToggleGroup>
        ) : null}
        <MenuRoot>
          <Tooltip label="More">
            <MenuTrigger>
              <Button
                aria-label="More"
                className="grid size-7 place-items-center rounded-md text-fg-tertiary transition-colors duration-150 hover:bg-surface-hover hover:text-fg-secondary active:bg-surface-active data-popup-open:bg-surface-hover max-md:size-10"
              >
                <Ellipsis size={15} strokeWidth={1.75} />
              </Button>
            </MenuTrigger>
          </Tooltip>
          <MenuPopup>
            <FileMenuItems path={path} folder={false} root={root} gone={gone} messageBox={messageBox} />
            {pane ? (
              <>
                <MenuSeparator />
                {pane.menu}
              </>
            ) : null}
          </MenuPopup>
        </MenuRoot>
        <IconButton icon={X} label="Close" shortcut="Ctrl W" onClick={onClose} className="max-md:size-10" />
      </div>
    </header>
  );

  return (
    <section aria-label={name} className="flex h-full flex-col">
      {pane ? <ContextMenuArea menu={pane.menu}>{header}</ContextMenuArea> : header}

      <div className="min-h-0 flex-1">
        <WorkspaceFolder value={root}>
          {view === "diff" && side !== undefined ? (
            <SideDiff
              root={root}
              path={path}
              side={side}
              onSide={setSide}
              layout={layout}
              context={whole ? WHOLE_FILE : CONTEXT}
              whole={whole}
              onWhole={() => setWhole(true)}
            />
          ) : view === "diff" ? (
            <DiffBody
              path={path}
              diff={diff}
              failure={
                AsyncResult.isFailure(diffResult)
                  ? messageOf(diffResult.cause, "Git couldn't compare that file.")
                  : undefined
              }
              from={from}
              renamed={state === "renamed"}
              layout={layout}
              whole={whole}
              onWhole={() => setWhole(true)}
            />
          ) : (
            <FileBody
              root={root}
              path={path}
              preview={preview}
              failure={
                AsyncResult.isFailure(previewResult)
                  ? messageOf(previewResult.cause, "That file couldn't be read.")
                  : undefined
              }
              rendered={view === "rendered"}
              wrap={wrap}
              messageBox={messageBox}
              onOpenFile={onOpenFile}
              outside={outside}
            />
          )}
        </WorkspaceFolder>
      </div>
    </section>
  );
}
