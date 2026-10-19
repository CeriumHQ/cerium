import { Button } from "@base-ui/react/button";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { FileState } from "@cerium/rpc";
import { useAtomValue } from "@effect/atom-react";
import { Cause, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { ChevronLeft, Ellipsis, FolderOpen, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { changesAtom, diffAtom, diffKey, previewAtom, previewKey } from "../../backend/explorer.ts";
import { shellBridge } from "../../backend/shell.ts";
import { FileIcon } from "../../components/FileIcon.tsx";
import { baseName } from "../../components/fileIcons/index.ts";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { MenuPopup, MenuRoot, MenuTrigger } from "../../components/ui/Menu.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { MessageBoxContext, type MessageBox } from "../composer/messageBox.ts";
import { WorkspaceFolder } from "../transcript/FileChip.tsx";
import { fileTargets } from "../transcript/menus.ts";
import { Markdown } from "../transcript/Markdown.tsx";
import { CodeView, DiffView } from "./CodeView.tsx";
import { FileMenuItems } from "./FileMenu.tsx";
import { StateLetter, TouchedMark } from "./FileStatus.tsx";
import { byteSize, dirOf, nameOf, stateAt, stateWord, touchWord } from "./model.ts";

type View = "diff" | "file" | "rendered";

const isMarkdown = (path: string) => /\.(?:md|mdx|markdown)$/i.test(path);

/** What a changed file can be looked at as: against the last commit, as it is, or (Markdown) as written. */
const viewsOf = (
  path: string,
  state: FileState | undefined,
): ReadonlyArray<{ value: View; label: string }> => {
  const changed =
    state === "modified" || state === "renamed" || state === "deleted" || state === "conflicted";
  return [
    ...(changed ? [{ value: "diff" as const, label: "Changes" }] : []),
    ...(state === "deleted"
      ? []
      : isMarkdown(path)
        ? [
            { value: "rendered" as const, label: "Preview" },
            { value: "file" as const, label: "Source" },
          ]
        : [{ value: "file" as const, label: "File" }]),
  ];
};

const messageOf = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : "That file couldn't be read.";
};

/** What fills the preview when there is no file to show: a line saying why. */
function Note({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center text-[13px] text-fg-tertiary max-md:text-[14px]">
      <p className="max-w-80 text-pretty">{children}</p>
    </div>
  );
}

function ImageBody({
  mediaType,
  data,
  size,
  name,
}: {
  mediaType: string;
  data: string;
  size: number;
  name: string;
}) {
  const [dimensions, setDimensions] = useState<string>();
  return (
    <div className="flex h-full flex-col">
      <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-6">
        <img
          src={`data:${mediaType};base64,${data}`}
          alt={name}
          onLoad={(event) =>
            setDimensions(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)
          }
          className="max-h-full max-w-full rounded-md border border-line-subtle bg-surface-window object-contain select-none"
        />
      </div>
      <p className="px-4 pb-3 text-center text-xs text-fg-tertiary tabular-nums">
        {dimensions ? `${dimensions} · ` : ""}
        {byteSize(size)}
      </p>
    </div>
  );
}

function FileBody({
  root,
  path,
  rendered,
  reveal,
  messageBox,
}: {
  root: string;
  path: string;
  rendered: boolean;
  reveal: (() => void) | undefined;
  messageBox: MessageBox | undefined;
}) {
  const result = useAtomValue(previewAtom(previewKey(root, path)));
  const preview = AsyncResult.value(result);
  // A file being read again keeps showing what was read.
  if (Option.isNone(preview)) {
    return AsyncResult.isFailure(result) ? <Note>{messageOf(result.cause)}</Note> : null;
  }
  const file = preview.value;
  switch (file._tag) {
    case "Missing":
      return <Note>This file isn't on disk any more.</Note>;
    case "Binary":
      return (
        <Note>
          <span className="block">Can't preview this file.</span>
          <span className="mt-1 block text-xs text-fg-disabled tabular-nums">{byteSize(file.size)}</span>
          {reveal ? (
            <Button
              onClick={reveal}
              className="mx-auto mt-3 flex h-8 items-center gap-1.5 rounded-md border border-line-strong px-3 text-[12.5px] text-fg-primary transition-colors hover:bg-surface-hover"
            >
              <FolderOpen size={13} strokeWidth={1.75} />
              Show in File Explorer
            </Button>
          ) : null}
        </Note>
      );
    case "Image":
      return <ImageBody {...file.image} size={file.size} name={nameOf(path)} />;
    case "Text": {
      if (file.text === "" && !file.truncated) return <Note>This file is empty.</Note>;
      return (
        <div className="flex h-full flex-col">
          <div className="min-h-0 flex-1">
            {rendered ? (
              <div className="scroll-thin h-full overflow-auto px-6 py-5 select-text max-md:px-4">
                <MessageBoxContext value={messageBox}>
                  <Markdown text={file.text} streaming={false} />
                </MessageBoxContext>
              </div>
            ) : (
              <CodeView text={file.text} path={path} />
            )}
          </div>
          {file.truncated ? (
            <p className="border-t border-line-subtle px-4 py-1.5 text-xs text-fg-tertiary tabular-nums">
              The first {byteSize(file.text.length)} of {byteSize(file.size)}
            </p>
          ) : null}
        </div>
      );
    }
  }
}

function DiffBody({
  root,
  path,
  from,
  rename,
}: {
  root: string;
  path: string;
  from: string | undefined;
  rename: boolean;
}) {
  const result = useAtomValue(diffAtom(diffKey(root, path, from)));
  const diff = AsyncResult.value(result);
  if (Option.isNone(diff)) {
    return AsyncResult.isFailure(result) ? <Note>{messageOf(result.cause)}</Note> : null;
  }
  const { hunks, binary, truncated } = diff.value;
  if (binary === true) return <Note>The contents changed, and they aren't text.</Note>;
  if (hunks.length === 0) {
    return (
      <Note>
        {rename && from !== undefined
          ? `Renamed from ${from}, contents unchanged.`
          : "Nothing differs from the last commit."}
      </Note>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <DiffView hunks={hunks} path={path} />
      </div>
      {truncated === true ? (
        <p className="border-t border-line-subtle px-4 py-1.5 text-xs text-fg-tertiary">
          A long diff, cut short.
        </p>
      ) : null}
    </div>
  );
}

/**
 * A file, read-only: its text highlighted, its changes against the last commit, an image, or a
 * line saying why not. Over the conversation on a desktop, in the Files pane on a phone.
 */
export function FilePreview({
  root,
  path,
  touch,
  variant,
  onClose,
  messageBox,
}: {
  /** The thread's folder. */
  root: string;
  /** The file, relative to `root`. */
  path: string;
  /** What this thread's agents did to it, when they touched it. */
  touch: "created" | "modified" | "deleted" | undefined;
  variant: "overlay" | "pane";
  onClose: () => void;
  messageBox: MessageBox | undefined;
}) {
  const changes = useAtomValue(changesAtom(root));
  const state = stateAt(changes, path);
  const from = changes.files.get(path)?.from;
  const views = viewsOf(path, state);
  const [chosen, setChosen] = useState<View>();
  const view = views.find((each) => each.value === chosen)?.value ?? views[0]?.value ?? "file";
  const location = fileTargets(path, false, root).location;
  const revealPath = shellBridge()?.revealPath;
  const reveal =
    state === "deleted" || location === undefined || !revealPath
      ? undefined
      : () => void revealPath(location);

  const element = useRef<HTMLElement>(null);
  // Esc closes the preview while focus is inside it, unless a menu there used the key first.
  const onEscape = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.key === "Escape" &&
      !event.defaultPrevented &&
      element.current?.contains(document.activeElement)
    ) {
      onClose();
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onEscape(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const dir = dirOf(path);
  const name = nameOf(path) || baseName(path);
  return (
    <section
      ref={element}
      aria-label={`Preview of ${name}`}
      className={`flex h-full flex-col ${variant === "overlay" ? "bg-surface-overlay backdrop-blur-2xl" : ""}`}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line-subtle pr-1.5 pl-3 max-md:h-12 max-md:pl-1.5">
        {variant === "pane" ? (
          <Button
            onClick={onClose}
            aria-label="Back to files"
            className="flex h-10 shrink-0 items-center gap-0.5 rounded-lg pr-2 pl-0.5 text-[15px] text-fg-secondary transition-colors active:bg-surface-active"
          >
            <ChevronLeft size={22} strokeWidth={1.75} />
          </Button>
        ) : null}
        <FileIcon path={path} className="size-4" />
        <span className="flex min-w-0 items-baseline gap-2 text-[13px] max-md:text-[15px]">
          <span className="shrink-0 font-medium text-fg-primary">{name}</span>
          {dir === "" ? null : <span className="min-w-0 truncate text-fg-tertiary">{dir}</span>}
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
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {views.length > 1 ? (
            <ToggleGroup
              value={[view]}
              onValueChange={(value) => {
                const next = views.find((each) => each.value === value[0]);
                if (next) setChosen(next.value);
              }}
              aria-label="View"
              className="flex items-center"
            >
              {views.map((each) => (
                <Toggle
                  key={each.value}
                  value={each.value}
                  className="rounded-md px-2 py-0.5 text-[12.5px] font-medium text-fg-tertiary transition-colors duration-150 select-none hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary max-md:px-2.5 max-md:py-1.5 max-md:text-[14px]"
                >
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
              <FileMenuItems
                path={path}
                folder={false}
                root={root}
                gone={state === "deleted"}
                messageBox={messageBox}
              />
            </MenuPopup>
          </MenuRoot>
          {variant === "overlay" ? (
            <IconButton icon={X} label="Close preview" shortcut="Esc" onClick={onClose} />
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <WorkspaceFolder value={root}>
          {view === "diff" ? (
            <DiffBody root={root} path={path} from={from} rename={state === "renamed"} />
          ) : (
            <FileBody
              root={root}
              path={path}
              rendered={view === "rendered"}
              reveal={reveal}
              messageBox={messageBox}
            />
          )}
        </WorkspaceFolder>
      </div>
    </section>
  );
}
