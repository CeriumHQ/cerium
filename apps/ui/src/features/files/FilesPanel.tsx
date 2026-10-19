import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { ChevronsDownUp, RefreshCw, Search, X } from "lucide-react";
import { useContext, useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from "react";

import { applyChanges, expandedAtom, treeAtom } from "../../backend/explorer.ts";
import { shellBridge } from "../../backend/shell.ts";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import type { MessageBox } from "../composer/messageBox.ts";
import { resolvePath } from "../transcript/paths.ts";
import { Filter, ChangesList } from "./FileLists.tsx";
import { FileTree } from "./FileTree.tsx";
import { ancestors, changedRows, type Touched } from "./model.ts";

type View = "files" | "changes";

const toggleClass =
  "rounded-md px-2 py-0.5 text-[13px] font-medium text-fg-tertiary transition-colors duration-150 select-none hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary max-md:px-2.5 max-md:py-1.5 max-md:text-[15px]";

/**
 * The thread's folder, beside the conversation: its files as a tree, or just what changed; a way to
 * find a file by name; and what git and this thread's agents did to each.
 */
export function FilesPanel({
  root,
  touched,
  messageBox,
  onClose,
}: {
  /** The thread's folder. */
  root: string;
  /** The files this thread's agents changed. */
  touched: Touched;
  messageBox: MessageBox | undefined;
  onClose: () => void;
}) {
  const registry = useContext(RegistryContext);
  const tree = useAtomValue(treeAtom(root));
  const [view, setView] = useState<View>("files");
  const [filtering, setFiltering] = useState(false);
  /** A path the tree should bring into view once its folders have loaded. */
  const [revealed, setRevealed] = useState<string>();
  const element = useRef<HTMLDivElement>(null);

  const changed = changedRows(tree.changes, touched);

  // Esc closes the panel while focus is inside it, unless something there (the filter, a menu) used the key first.
  const onEscape = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (
      event.key === "Escape" &&
      !event.defaultPrevented &&
      element.current?.contains(document.activeElement)
    ) {
      onClose();
    }
  });
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => onEscape(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // A file opens in the app the system gives its kind, on this computer only.
  const opener = shellBridge()?.openPath;
  const open =
    opener === undefined
      ? undefined
      : (path: string) => {
          const location = resolvePath(path, root);
          if (location !== undefined) void opener(location);
        };

  /** Opens the folders above `path` (and `path` itself, a folder) and shows it in the tree. */
  const reveal = (path: string, folder: boolean) => {
    registry.update(
      expandedAtom(root),
      (current) => new Set([...current, ...ancestors(path), ...(folder ? [path] : [])]),
    );
    setView("files");
    setFiltering(false);
    setRevealed(path);
  };

  const collapseAll = () => registry.set(expandedAtom(root), new Set());
  const refresh = () =>
    applyChanges(
      registry,
      root,
      { paths: [], status: true, overflow: true },
      registry.get(expandedAtom(root)),
    );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      setView("files");
      setFiltering(true);
    }
  };

  const body =
    view === "changes" ? (
      <ScrollArea className="h-full">
        <ChangesList
          rows={changed}
          repository={tree.changes.repository}
          root={root}
          messageBox={messageBox}
          onOpen={open}
          onReveal={(path) => reveal(path, true)}
        />
      </ScrollArea>
    ) : tree.error !== undefined ? (
      <p className="px-4 py-6 text-center text-[13px] text-balance text-fg-tertiary max-md:text-[14px]">
        {tree.error}
      </p>
    ) : tree.rows.length === 0 && !tree.loading ? (
      <p className="px-4 py-6 text-center text-[13px] text-fg-tertiary max-md:text-[14px]">
        This folder is empty.
      </p>
    ) : (
      <ScrollArea className="h-full">
        <FileTree
          root={root}
          tree={tree}
          touched={touched}
          messageBox={messageBox}
          revealed={revealed}
          onRevealed={() => setRevealed(undefined)}
          onOpen={open}
        />
      </ScrollArea>
    );

  return (
    // Ctrl F finds a file from anywhere in the panel; everything else keeps its own keys.
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
    <div ref={element} onKeyDown={onKeyDown} className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center gap-1 border-b border-line-subtle pr-1.5 pl-2 max-md:h-12 max-md:pl-3">
        <ToggleGroup
          value={[view]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "files" || next === "changes") setView(next);
          }}
          aria-label="Show"
          className="flex items-center"
        >
          <Toggle value="files" className={toggleClass}>
            Files
          </Toggle>
          <Toggle value="changes" className={toggleClass}>
            Changes
            {changed.length > 0 ? (
              <span className="ml-1.5 text-fg-tertiary tabular-nums">{changed.length}</span>
            ) : null}
          </Toggle>
        </ToggleGroup>
        <div className="ml-auto flex items-center">
          {view === "files" ? (
            <>
              <IconButton
                icon={Search}
                label="Find a file"
                shortcut="Ctrl F"
                onClick={() => setFiltering((now) => !now)}
                className="max-md:size-10"
              />
              <IconButton
                icon={ChevronsDownUp}
                label="Collapse all"
                onClick={collapseAll}
                className="max-md:size-10"
              />
            </>
          ) : null}
          <IconButton icon={RefreshCw} label="Refresh" onClick={refresh} className="max-md:size-10" />
          <IconButton
            icon={X}
            label="Close"
            shortcut="Ctrl Shift E"
            onClick={onClose}
            className="max-md:size-10"
          />
        </div>
      </header>

      {filtering && view === "files" ? (
        <Filter
          root={root}
          messageBox={messageBox}
          onClose={() => setFiltering(false)}
          onChoose={(entry) => {
            reveal(entry.path, entry.folder);
            if (!entry.folder) open?.(entry.path);
          }}
        >
          {body}
        </Filter>
      ) : (
        <div className="min-h-0 flex-1">{body}</div>
      )}
    </div>
  );
}
