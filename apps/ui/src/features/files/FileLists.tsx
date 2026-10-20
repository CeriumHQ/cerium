import { Autocomplete } from "@base-ui/react/autocomplete";
import type { WorkspaceEntry } from "@cerium/protocol";
import { useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { LoaderCircle, Search, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useDeferredValue, useRef, useState } from "react";

import { workspaceSearchAtom, workspaceSearchKey } from "../../backend/files.ts";
import { FileIcon } from "../../components/FileIcon.tsx";
import { IconButton } from "../../components/ui/IconButton.tsx";
import { ContextMenuArea } from "../../components/ui/Menu.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import type { MessageBox } from "../composer/messageBox.ts";
import { FileMenuItems } from "./FileMenu.tsx";
import { StateLetter } from "./FileStatus.tsx";
import { dirOf, nameOf, type ChangedRow, type OpenFile } from "./model.ts";

/** A file or folder in a flat list: its icon, its name, where it is, and what happened to it. */
function RowContent({
  path,
  folder,
  gone = false,
  trailing,
}: {
  path: string;
  folder: boolean;
  gone?: boolean;
  trailing?: ReactNode;
}) {
  const dir = dirOf(path);
  return (
    <>
      <FileIcon path={path} folder={folder} className="size-4" />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className={`shrink-0 ${gone ? "text-fg-tertiary line-through" : ""}`}>{nameOf(path)}</span>
        {dir === "" ? null : <span className="min-w-0 truncate text-fg-tertiary">{dir}</span>}
      </span>
      {trailing}
    </>
  );
}

const rowClass =
  "flex h-8 w-full cursor-default items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-fg-primary outline-none select-none focus-visible:ring-1 focus-visible:ring-focus-ring focus-visible:ring-inset max-md:h-11 max-md:text-[14px]";

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="px-4 py-6 text-center text-[13px] text-balance text-fg-tertiary max-md:text-[14px]">
    {children}
  </p>
);

/**
 * What changed in the folder: the files git says differ from the last commit, by path, whoever
 * changed them.
 */
export function ChangesList({
  rows,
  repository,
  root,
  messageBox,
  activePath,
  onOpen,
  viewer,
  onReveal,
}: {
  rows: ReadonlyArray<ChangedRow>;
  repository: boolean;
  root: string;
  messageBox: MessageBox | undefined;
  /** The file the viewer shows. */
  activePath: string | undefined;
  /** Opens a file at its changes; absent where nothing can. */
  onOpen: OpenFile | undefined;
  /** Opens a file in Cerium's viewer, for the rows' menus; absent where the machine can't serve one. */
  viewer: OpenFile | undefined;
  /** Shows a folder in the tree. */
  onReveal: (path: string) => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  if (rows.length === 0) {
    return (
      <Empty>
        {repository
          ? "Nothing differs from the last commit."
          : "This folder isn't in git, so there's nothing to compare with."}
      </Empty>
    );
  }
  // The arrows move between rows; Tab lands on one of them only.
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>("button") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "ArrowDown"
        ? at + 1
        : event.key === "ArrowUp"
          ? at - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : undefined;
    if (next === undefined || items[next] === undefined) return;
    event.preventDefault();
    items[next].focus();
  };
  const first = rows[0]?.path;
  return (
    // The arrows move between the rows' buttons, which take the keys themselves.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <ul ref={list} aria-label="Changes" onKeyDown={onKeyDown} className="flex flex-col gap-px p-1.5">
      {rows.map((row) => (
        <li key={row.path}>
          <ContextMenuArea
            menu={
              <FileMenuItems
                path={row.path}
                folder={row.folder}
                root={root}
                gone={row.state === "deleted"}
                messageBox={messageBox}
                onOpen={viewer && !row.folder ? () => viewer(row.path, { changes: true }) : undefined}
              />
            }
          >
            <button
              type="button"
              tabIndex={row.path === first ? 0 : -1}
              aria-current={!row.folder && row.path === activePath ? "page" : undefined}
              onClick={(event) => {
                if (row.folder) {
                  if (event.detail < 2) onReveal(row.path);
                } else onOpen?.(row.path, { changes: true });
              }}
              onAuxClick={(event) => {
                if (event.button === 1 && !row.folder) onOpen?.(row.path, { changes: true });
              }}
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault();
              }}
              className={`${rowClass} transition-colors hover:bg-surface-hover aria-[current=page]:bg-surface-selected`}
            >
              <RowContent
                path={row.path}
                folder={row.folder}
                gone={row.state === "deleted"}
                trailing={
                  <span className="flex shrink-0 items-center gap-1.5">
                    {row.state ? <StateLetter state={row.state} /> : null}
                  </span>
                }
              />
            </button>
          </ContextMenuArea>
        </li>
      ))}
    </ul>
  );
}

/** What a search of an empty name finds: nothing, without asking. */
const noMatches = Atom.make(AsyncResult.success<ReadonlyArray<WorkspaceEntry>>([]));

/**
 * A field that finds files and folders by name anywhere in the folder, and lists them in place of
 * `children` (the tree) while something is typed. The arrows move through the matches and Enter
 * chooses one; Esc clears the field, then closes it.
 */
export function Filter({
  root,
  messageBox,
  children,
  onChoose,
  onClose,
}: {
  root: string;
  messageBox: MessageBox | undefined;
  /** What shows while nothing is typed. */
  children: ReactNode;
  onChoose: (entry: WorkspaceEntry) => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const query = useDeferredValue(typed.trim());
  const result = useAtomValue(
    query === "" ? noMatches : workspaceSearchAtom(workspaceSearchKey(root, query)),
  );
  const found = AsyncResult.value(result);
  const entries = Option.getOrElse(found, (): ReadonlyArray<WorkspaceEntry> => []);

  return (
    <Autocomplete.Root
      open
      inline
      items={entries}
      value={typed}
      onValueChange={setTyped}
      filter={null}
      autoHighlight="always"
      keepHighlight
      itemToStringValue={(entry: WorkspaceEntry) => entry.path}
    >
      <Autocomplete.InputGroup className="flex h-9 shrink-0 items-center gap-2 border-b border-line-subtle pr-1.5 pl-3 max-md:h-12">
        <Search size={13} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" aria-hidden />
        <Autocomplete.Input
          // The field opens because it was asked for, so typing starts at once.
          // oxlint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          aria-label="Find a file or folder"
          placeholder="Find a file or folder"
          spellCheck={false}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            // Clearing what was typed comes before closing the field.
            event.preventBaseUIHandler();
            event.preventDefault();
            if (typed === "") onClose();
            else setTyped("");
          }}
          className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg-primary outline-none placeholder:text-fg-tertiary max-md:text-[14px]"
        />
        <IconButton icon={X} label="Close filter" onClick={onClose} className="max-md:size-10" />
      </Autocomplete.InputGroup>

      <div className="min-h-0 flex-1">
        {query === "" ? (
          children
        ) : Option.isNone(found) ? (
          <div className="grid place-items-center py-6 text-fg-tertiary">
            {AsyncResult.isFailure(result) ? (
              <Empty>Couldn't search this folder.</Empty>
            ) : (
              <LoaderCircle size={14} className="animate-spin" />
            )}
          </div>
        ) : entries.length === 0 ? (
          <Empty>No file or folder with that name.</Empty>
        ) : (
          <ScrollArea className="h-full">
            <Autocomplete.List className="flex flex-col gap-px p-1.5 outline-none">
              {(entry: WorkspaceEntry) => (
                <ContextMenuArea
                  key={entry.path}
                  menu={
                    <FileMenuItems
                      path={entry.path}
                      folder={entry.folder}
                      root={root}
                      messageBox={messageBox}
                    />
                  }
                >
                  <Autocomplete.Item
                    value={entry}
                    onClick={() => onChoose(entry)}
                    className={`${rowClass} [scroll-margin-block:0.375rem] data-highlighted:bg-surface-active`}
                  >
                    <RowContent path={entry.path} folder={entry.folder} />
                  </Autocomplete.Item>
                </ContextMenuArea>
              )}
            </Autocomplete.List>
          </ScrollArea>
        )}
      </div>
    </Autocomplete.Root>
  );
}
