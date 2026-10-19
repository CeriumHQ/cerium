import { RegistryContext } from "@effect/atom-react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import { useContext, useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from "react";

import { expandedAtom, refreshListing, type Tree } from "../../backend/explorer.ts";
import { FileIcon } from "../../components/FileIcon.tsx";
import { ContextMenuArea } from "../../components/ui/Menu.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import type { MessageBox } from "../composer/messageBox.ts";
import { FileMenuItems } from "./FileMenu.tsx";
import { StateDot, StateLetter, TouchedMark } from "./FileStatus.tsx";
import {
  keyAction,
  stateWord,
  touchedKey,
  touchWord,
  typeAhead,
  wantsTab,
  type KeyAction,
  type OpenFile,
  type Row,
  type Touched,
} from "./model.ts";

/** How long a pause ends what was typed to jump to a name. */
const TYPE_AHEAD_MS = 700;
/** Each level of folders is this far in, in pixels. */
const INDENT = 14;

/** What a row's tooltip says beyond its path. */
const notes = (row: Row, touch: "created" | "modified" | "deleted" | undefined): ReadonlyArray<string> => [
  ...(row.state && !row.folder ? [stateWord[row.state]] : []),
  ...(row.rollup ? [row.rollup.count === 1 ? "1 change inside" : `${row.rollup.count} changes inside`] : []),
  ...(touch ? [touchWord(touch)] : []),
  ...(row.ignored ? ["Ignored by git"] : []),
  ...(row.heavy ? ["Dependencies, build output or caches"] : []),
  ...(row.link ? ["A link"] : []),
];

function TreeRow({
  row,
  root,
  focusable,
  touch,
  touchedInside,
  shown,
  messageBox,
  onFocus,
  onActivate,
  onOpenTab,
}: {
  row: Row;
  root: string;
  /** The one row the Tab key lands on. */
  focusable: boolean;
  touch: "created" | "modified" | "deleted" | undefined;
  touchedInside: boolean;
  /** The viewer shows this file. */
  shown: boolean;
  messageBox: MessageBox | undefined;
  onFocus: () => void;
  /** Pressed: `tab` when it asked for a tab of its own. */
  onActivate: (tab: boolean) => void;
  /** Opens the file in the viewer in a tab of its own, from its menu; absent without a viewer. */
  onOpenTab: (() => void) | undefined;
}) {
  const extra = notes(row, touch);
  const changed = row.state !== undefined;
  const muted = row.ignored || row.heavy;
  return (
    <ContextMenuArea
      menu={
        <FileMenuItems
          path={row.path}
          folder={row.folder}
          root={root}
          gone={row.gone}
          messageBox={messageBox}
          onOpen={onOpenTab}
        />
      }
    >
      <Tooltip
        side="left"
        label={
          <span className="flex flex-col gap-0.5">
            <span className="font-mono text-[11px] break-all">{row.path}</span>
            {extra.map((note) => (
              <span key={note} className="text-2xs text-fg-tertiary">
                {note}
              </span>
            ))}
          </span>
        }
      >
        {/* The tree takes the keys for its rows, so a row needn't. */}
        {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events */}
        <div
          role="treeitem"
          tabIndex={focusable ? 0 : -1}
          aria-level={row.depth + 1}
          aria-expanded={row.folder ? row.expanded : undefined}
          data-path={row.path}
          aria-selected={shown}
          onClick={(event) => onActivate(wantsTab(event))}
          onAuxClick={(event) => {
            if (event.button === 1) onActivate(true);
          }}
          onMouseDown={(event) => {
            // The middle button opens on release; pressed, it would start the browser's autoscroll.
            if (event.button === 1) event.preventDefault();
          }}
          onFocus={onFocus}
          style={{ paddingLeft: 4 + row.depth * INDENT }}
          className={`flex h-7 cursor-default items-center gap-1.5 rounded-md pr-2 text-[12.5px] outline-none [content-visibility:auto] [contain-intrinsic-size:auto_28px] hover:bg-surface-hover aria-selected:bg-surface-selected focus-visible:ring-1 focus-visible:ring-focus-ring focus-visible:ring-inset data-popup-open:bg-surface-hover max-md:h-11 max-md:text-[14px] max-md:[contain-intrinsic-size:auto_44px] ${
            changed || touch ? "text-fg-primary" : "text-fg-secondary"
          }`}
        >
          <span className="grid size-4 shrink-0 place-items-center text-fg-tertiary">
            {row.folder ? (
              row.loading ? (
                <LoaderCircle size={12} className="animate-spin" />
              ) : (
                <ChevronRight
                  size={13}
                  strokeWidth={2}
                  className={`transition-transform duration-150 ${row.expanded ? "rotate-90" : ""}`}
                />
              )
            ) : null}
          </span>
          <span className={`flex min-w-0 flex-1 items-center gap-1.5 ${muted ? "opacity-55" : ""}`}>
            <FileIcon path={row.path} folder={row.folder} className="size-4" />
            <span className={`min-w-0 truncate ${row.gone ? "text-fg-tertiary line-through" : ""}`}>
              {row.name}
            </span>
          </span>
          {touch ? (
            <TouchedMark change={touch} />
          ) : touchedInside && row.folder ? (
            <TouchedMark change="modified" />
          ) : null}
          {row.folder ? (
            row.state && !row.gone ? (
              <StateLetter state={row.state} />
            ) : row.rollup && !row.expanded ? (
              <StateDot state={row.rollup.state} count={row.rollup.count} />
            ) : null
          ) : row.state ? (
            <StateLetter state={row.state} />
          ) : null}
        </div>
      </Tooltip>
    </ContextMenuArea>
  );
}

/**
 * The folder as a tree you can walk with the keyboard: the arrows move and open and close folders,
 * Home and End jump, Enter opens a file, and typing a name jumps to it.
 */
export function FileTree({
  root,
  tree,
  touched,
  messageBox,
  revealed,
  onRevealed,
  activePath,
  onOpen,
  viewer,
}: {
  root: string;
  tree: Tree;
  touched: Touched;
  messageBox: MessageBox | undefined;
  /** A path to bring into view and focus as soon as its row is there. */
  revealed: string | undefined;
  onRevealed: () => void;
  /** The file the viewer shows. */
  activePath: string | undefined;
  /** Opens a file; absent where nothing can. */
  onOpen: OpenFile | undefined;
  /** Opens a file in Cerium's viewer, for the rows' menus; absent where the machine can't serve one. */
  viewer: OpenFile | undefined;
}) {
  const registry = useContext(RegistryContext);
  const container = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const [focused, setFocused] = useState<string>();
  const { rows } = tree;

  // A revealed row may only exist once its folders have been read.
  const revealDone = useEffectEvent(onRevealed);
  useEffect(() => {
    if (revealed === undefined) return;
    const element = container.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(revealed)}"]`);
    if (element === null || element === undefined) return;
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "center" });
    revealDone();
  }, [revealed, rows]);

  const found = rows.findIndex((row) => row.path === focused);
  const focusIndex = found < 0 ? 0 : found;

  const setOpen = (path: string, open: boolean) => {
    registry.update(expandedAtom(root), (current) => {
      const next = new Set(current);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });
    // What was read while it was closed may be out of date.
    if (open) refreshListing(registry, root, path);
  };

  const focusRow = (index: number) => {
    const row = rows[index];
    if (row === undefined) return;
    setFocused(row.path);
    container.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(row.path)}"]`)?.focus();
  };

  const run = (action: KeyAction) => {
    switch (action.kind) {
      case "focus":
        return focusRow(action.index);
      case "expand":
        return setOpen(action.path, true);
      case "collapse":
        return setOpen(action.path, false);
      case "toggle":
        return setOpen(action.path, !rows.some((row) => row.path === action.path && row.expanded));
      case "open":
        return onOpen?.(action.path);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const word = typed.current;
    const typing = word.text !== "" && Date.now() - word.at < TYPE_AHEAD_MS;
    // A space in the middle of a name being typed belongs to the name.
    if (event.key === " " && typing) {
      word.text += " ";
      word.at = Date.now();
    } else {
      const action = keyAction(rows, focusIndex, event.key);
      if (action !== undefined) {
        event.preventDefault();
        run(action);
        return;
      }
      if (event.key.length !== 1) return;
      word.text = typing ? word.text + event.key : event.key;
      word.at = Date.now();
    }
    event.preventDefault();
    const match = typeAhead(rows, focusIndex, word.text);
    if (match !== undefined) focusRow(match);
  };

  return (
    <div
      ref={container}
      role="tree"
      aria-label="Files"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-px p-1.5 outline-none"
    >
      {rows.map((row, index) => (
        <TreeRow
          key={row.path}
          row={row}
          root={root}
          focusable={index === focusIndex}
          touch={row.folder ? undefined : touched.files.get(touchedKey(touched, row.path))?.change}
          touchedInside={row.folder && !row.expanded && touched.folders.has(touchedKey(touched, row.path))}
          shown={!row.folder && row.path === activePath}
          onOpenTab={viewer && !row.folder && !row.gone ? () => viewer(row.path, { tab: true }) : undefined}
          messageBox={messageBox}
          onFocus={() => setFocused(row.path)}
          onActivate={(tab) => {
            setFocused(row.path);
            // A folder opens and closes once, however many clicks a double click counts.
            if (row.folder) {
              if (!tab) setOpen(row.path, !row.expanded);
            } else onOpen?.(row.path, { tab });
          }}
        />
      ))}
    </div>
  );
}
