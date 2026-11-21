import { Autocomplete } from "@base-ui/react/autocomplete";
import { Dialog } from "@base-ui/react/dialog";
import type { WorkspaceEntry } from "@cerium/protocol";
import type { ThreadMatch } from "@cerium/rpc";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { Archive, FolderOpen, MessagesSquare, Monitor, Search, X } from "lucide-react";
import { Fragment, useId, useRef, useState } from "react";

import { paletteFilesAtom, workspaceSearchKey } from "../../backend/files.ts";
import { threadSearchAtom, threadSearchKey } from "../../backend/search.ts";
import { FileIcon } from "../../components/FileIcon.tsx";
import { dialogBackdropClass } from "../../components/ui/FormDialog.tsx";
import { InlineSelect } from "../../components/ui/InlineSelect.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { keyLabel, usesCommandKey } from "../../lib/keys.ts";
import { shortAgo } from "../../lib/time.ts";
import type { ThreadSummary } from "../threads/model.ts";
import { projectName } from "../composer/projectList.ts";
import { dirOf, nameOf } from "../files/model.ts";
import { findJumpAtom } from "../transcript/find.ts";
import { ThreadMark } from "../threads/StatusIndicator.tsx";
import {
  highlight,
  MIN_MESSAGE_QUERY,
  queryWords,
  searchResults,
  type MessageHit,
  type Piece,
  type SearchResult,
} from "../threads/threadSearch.ts";
import {
  paletteGroups,
  paletteOpen,
  type PaletteCommand,
  type PaletteEntry,
  type PaletteGroup,
  type PaletteOpen,
} from "./palette.ts";

const noMatches: Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<ThreadMatch>, unknown>> = Atom.make(
  AsyncResult.success<ReadonlyArray<ThreadMatch>>([]),
);
const noFiles = Atom.make(AsyncResult.success<ReadonlyArray<WorkspaceEntry>>([]));

/** How many recent threads the palette offers before anything is typed. */
const RECENT = 4;

const hitOf = ({ threadId, passage }: ThreadMatch): MessageHit => ({ threadId, passage });

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly mode: "work" | "chat";
  /** Every thread across work and chat, including threads set aside in either mode. */
  readonly threads: ReadonlyArray<ThreadSummary>;
  /** Whether the machine the window drives can search messages; older ones are searched by title. */
  readonly messageSearch: boolean;
  readonly onOpenThread: (threadId: string, as: PaletteOpen) => void;
  readonly fileRoots: ReadonlyArray<string>;
  readonly onOpenFile: (root: string, path: string, as: PaletteOpen) => void;
  readonly modifierShortcuts: boolean;
  /** The actions and settings pages it can run. */
  readonly commands: ReadonlyArray<PaletteCommand>;
}

/**
 * Finds a thread or runs a command: Ctrl K, or the sidebar's search button. Commands (actions, with the
 * key each has, and settings pages) and thread titles filter as the user types; what was said in the
 * threads is looked up on the machine after a pause and joins the list below, each with the passage
 * that matched. Arrows move, Enter opens or runs, Esc closes.
 */
export function CommandPalette({ open, onOpenChange, ...panel }: CommandPaletteProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={dialogBackdropClass} />
        {/* A phone's keyboard covers part of the page, so the dialog follows the part that's visible (web/viewport.ts). */}
        <Dialog.Viewport className="fixed inset-0 flex items-start justify-center px-2 pt-[12vh] pb-2 max-md:top-[var(--app-top,0px)] max-md:bottom-auto max-md:h-[var(--app-height,100%)] max-md:pt-[max(0.5rem,env(safe-area-inset-top))] max-md:pr-[max(0.5rem,env(safe-area-inset-right))] max-md:pl-[max(0.5rem,env(safe-area-inset-left))]">
          <Dialog.Popup
            aria-label="Command palette"
            className="flex max-h-[min(34rem,calc(100dvh-5rem))] w-full max-md:max-h-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line-subtle bg-surface-overlay text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale,translate] duration-150 ease-out-soft outline-none data-ending-style:-translate-y-2 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:-translate-y-2 data-starting-style:scale-[0.98] data-starting-style:opacity-0"
          >
            <PalettePanel
              {...panel}
              onOpenThread={(threadId, as) => {
                onOpenChange(false);
                panel.onOpenThread(threadId, as);
              }}
              onOpenFile={(root, path, as) => {
                onOpenChange(false);
                panel.onOpenFile(root, path, as);
              }}
              onRun={(command) => {
                onOpenChange(false);
                command.run();
              }}
            />
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The palette itself, which starts empty each time the dialog opens. */
function PalettePanel({
  mode,
  threads,
  messageSearch,
  onOpenThread,
  fileRoots,
  onOpenFile,
  modifierShortcuts,
  commands,
  onRun,
}: Omit<CommandPaletteProps, "open" | "onOpenChange"> & {
  readonly onRun: (command: PaletteCommand) => void;
}) {
  const [typed, setTyped] = useState("");
  const [pickedRoot, setPickedRoot] = useState<string>();
  const highlighted = useRef<string>(undefined);
  const shortcutsId = useId();
  const jumpTo = useAtomSet(findJumpAtom);
  const query = typed.trim();
  const words = queryWords(query);
  const asking = messageSearch && words.length > 0 && query.length >= MIN_MESSAGE_QUERY;
  const otherMode = mode === "work" ? "chat" : "work";
  const found = useAtomValue(asking ? threadSearchAtom(threadSearchKey(mode, query)) : noMatches);
  const other = useAtomValue(asking ? threadSearchAtom(threadSearchKey(otherMode, query)) : noMatches);
  const hits = [found, other].flatMap((each) => (AsyncResult.isSuccess(each) ? each.value.map(hitOf) : []));
  const root = pickedRoot !== undefined && fileRoots.includes(pickedRoot) ? pickedRoot : fileRoots[0];
  const askingFiles = root !== undefined && query !== "";
  const files = useAtomValue(askingFiles ? paletteFilesAtom(workspaceSearchKey(root, query)) : noFiles);
  const results = searchResults(threads, query, hits);
  // Nothing typed lists fewer recent threads, to leave the actions below them in view.
  const groups = paletteGroups(
    query === "" ? results.slice(0, RECENT) : results,
    commands,
    query,
    AsyncResult.isSuccess(files) ? files.value : [],
  );
  const looking = (asking && (found.waiting || other.waiting)) || (askingFiles && files.waiting);
  const notes = [
    looking ? "Searching…" : undefined,
    query !== "" && !messageSearch ? "Update Cerium on that computer to search messages." : undefined,
    asking && (AsyncResult.isFailure(found) || AsyncResult.isFailure(other))
      ? "Some messages couldn't be searched."
      : undefined,
    askingFiles && AsyncResult.isFailure(files) ? "Couldn't search project files." : undefined,
  ].filter((note) => note !== undefined);
  // A project's name is only worth a result's room when the threads span more than one.
  const projects = new Set(threads.map((thread) => thread.folder)).size > 1;
  const openEntry = (entry: PaletteEntry, as: PaletteOpen) => {
    if (entry.kind === "command") return onRun(entry.command);
    if (entry.kind === "file") {
      if (root !== undefined) onOpenFile(root, entry.path, as);
      return;
    }
    const { thread, passage } = entry.result;
    // A message the search found: the thread opens on it, its words marked.
    if (passage !== undefined) jumpTo({ threadId: thread.id, passage, at: Date.now() });
    onOpenThread(thread.id, as);
  };

  return (
    <Autocomplete.Root
      open
      inline
      items={groups}
      value={typed}
      onValueChange={setTyped}
      filter={null}
      autoHighlight="always"
      keepHighlight
      onItemHighlighted={(entry: PaletteEntry | undefined) => {
        highlighted.current = entry?.key;
      }}
      itemToStringValue={(entry: PaletteEntry) =>
        entry.kind === "thread"
          ? entry.result.thread.title
          : entry.kind === "file"
            ? entry.path
            : entry.command.label
      }
    >
      <Autocomplete.InputGroup className="flex shrink-0 items-center gap-2.5 border-b border-line-subtle pr-2 pl-3.5">
        <Search size={15} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" aria-hidden />
        <Autocomplete.Input
          aria-label="Search threads, chats, project files and commands"
          aria-describedby={modifierShortcuts ? shortcutsId : undefined}
          placeholder="Search threads, chats, files and commands"
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            const as = paletteOpen(event, usesCommandKey());
            if (as === "default") return;
            const entry = groups.flatMap(({ items }) => items).find(({ key }) => key === highlighted.current);
            if (entry === undefined) return;
            // Base UI uses element.click() for Enter, which loses keyboard modifiers.
            event.preventBaseUIHandler();
            event.preventDefault();
            openEntry(entry, as);
          }}
          className="h-12 min-w-0 flex-1 bg-transparent text-reading text-fg-primary outline-none placeholder:text-fg-tertiary max-md:text-[16px]"
        />
        <Dialog.Close
          aria-label="Close search"
          className="hidden size-9 shrink-0 place-items-center rounded-lg text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary max-md:grid"
        >
          <X size={16} strokeWidth={1.75} />
        </Dialog.Close>
      </Autocomplete.InputGroup>

      {groups.length === 0 ? (
        <output className="block px-4 py-8 text-center text-body text-fg-tertiary max-md:text-[15px]">
          {query === "" ? "No threads yet." : notes.join(" ") || "Nothing matches."}
        </output>
      ) : (
        <ScrollArea
          className="flex-1"
          viewportClassName="max-h-[min(24rem,calc(100dvh-10rem))] max-md:max-h-[min(26rem,calc(var(--app-height,100dvh)-6.5rem))]"
        >
          <Autocomplete.List className="flex flex-col p-1.5 outline-none">
            {(group: PaletteGroup) => (
              <Autocomplete.Group key={group.value} items={group.items} className="flex flex-col gap-px">
                <Autocomplete.GroupLabel className="px-2 pt-2 pb-0.5 text-meta font-medium text-fg-secondary/80 first:pt-1">
                  {group.value}
                </Autocomplete.GroupLabel>
                <Autocomplete.Collection>
                  {(entry: PaletteEntry) => (
                    <Autocomplete.Item
                      key={entry.key}
                      value={entry}
                      onClick={(event) => openEntry(entry, paletteOpen(event, usesCommandKey()))}
                      className="flex cursor-default items-start gap-2.5 rounded-lg px-2 py-1.5 outline-none select-none [scroll-margin-block:0.375rem] data-highlighted:bg-surface-active max-md:gap-3 max-md:py-2.5"
                    >
                      {entry.kind === "thread" ? (
                        <ResultRow result={entry.result} words={words} projects={projects} />
                      ) : entry.kind === "file" ? (
                        <FileRow path={entry.path} words={words} />
                      ) : (
                        <CommandRow command={entry.command} words={words} />
                      )}
                    </Autocomplete.Item>
                  )}
                </Autocomplete.Collection>
              </Autocomplete.Group>
            )}
          </Autocomplete.List>
        </ScrollArea>
      )}
      {groups.length > 0 && notes.length > 0 ? (
        <output className="block shrink-0 border-t border-line-subtle px-4 py-2 text-meta text-fg-tertiary">
          {notes.join(" ")}
        </output>
      ) : null}
      {/* Where files are searched, and how a result opens other than in place. */}
      {root === undefined && !modifierShortcuts ? null : (
        <div className="flex h-9 shrink-0 items-center gap-3 border-t border-line-subtle bg-surface-sunken/50 pr-3 pl-2 text-caption text-fg-tertiary max-md:h-11">
          {root === undefined ? null : (
            <label className="flex min-w-0 items-center gap-1">
              <span className="sr-only">File search project</span>
              <FolderOpen size={12} strokeWidth={1.75} aria-hidden className="ml-1 shrink-0" />
              <span aria-hidden className="shrink-0 pl-0.5 max-md:text-[13px]">
                Files in
              </span>
              <InlineSelect
                value={root}
                onChange={(event) => setPickedRoot(event.target.value)}
                disabled={fileRoots.length < 2}
                title={root}
                className="max-w-56"
              >
                {fileRoots.map((folder) => (
                  <option key={folder} value={folder}>
                    {projectName(folder)} ({folder})
                  </option>
                ))}
              </InlineSelect>
            </label>
          )}
          {modifierShortcuts ? (
            <p id={shortcutsId} className="ml-auto flex shrink-0 items-center gap-3 max-md:hidden">
              <span className="flex items-center gap-1.5">
                <Kbd>{keyLabel("Ctrl Enter")}</Kbd>
                new tab
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>{keyLabel("Alt Enter")}</Kbd>
                split
              </span>
            </p>
          ) : null}
        </div>
      )}
    </Autocomplete.Root>
  );
}

function CommandRow({ command, words }: { command: PaletteCommand; words: ReadonlyArray<string> }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2.5">
      <command.icon size={14} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-body text-fg-secondary max-md:text-[15px]">
        <Marked pieces={highlight(command.label, words)} />
      </span>
      {command.detail === undefined ? null : (
        // A path reads from its end, where folders that share a name differ, so it gives way at its start.
        <span
          dir="rtl"
          title={command.detail}
          className="max-w-[45%] shrink truncate text-left font-mono text-caption text-fg-tertiary max-md:hidden"
        >
          <bdi>{command.detail}</bdi>
        </span>
      )}
      {command.keys ? (
        <kbd className="shrink-0 font-sans text-caption text-fg-tertiary max-md:hidden">
          {keyLabel(command.keys)}
        </kbd>
      ) : null}
    </span>
  );
}

function ResultRow({
  result,
  words,
  projects,
}: {
  result: SearchResult;
  words: ReadonlyArray<string>;
  projects: boolean;
}) {
  const { thread, passage } = result;
  const offline = thread.elsewhere?.online === false;
  return (
    <>
      <span className="mt-[3px] grid shrink-0 place-items-center max-md:mt-[5px]">
        <ThreadMark thread={thread} unread={thread.unread} size="small" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <span
            className={`min-w-0 flex-1 truncate text-body max-md:text-[15px] ${thread.unread ? "font-medium text-fg-primary" : "text-fg-secondary"}`}
          >
            <Marked pieces={highlight(thread.title, words)} />
          </span>
          {projects && thread.project ? (
            <span className="max-w-[35%] shrink-0 truncate text-caption text-fg-tertiary max-md:text-[12px]">
              {thread.project}
            </span>
          ) : null}
          {thread.mode === "chat" ? (
            <span className="flex shrink-0 items-center gap-1 rounded border border-line-subtle px-1 text-caption leading-4 text-fg-tertiary max-md:text-[12px]">
              <MessagesSquare size={10} strokeWidth={2} aria-hidden />
              Chat
            </span>
          ) : null}
          {thread.machine ? (
            <span className={`shrink-0 text-fg-tertiary ${offline ? "opacity-60" : ""}`}>
              <Monitor size={11} strokeWidth={2} aria-label={`On ${thread.machine}`} />
            </span>
          ) : null}
          {thread.archivedAt === undefined ? null : (
            <span className="shrink-0 text-fg-tertiary">
              <Archive size={11} strokeWidth={2} aria-label="Archived" />
            </span>
          )}
          <span className="w-6 shrink-0 text-right text-caption text-fg-tertiary tabular-nums max-md:text-[12px]">
            {shortAgo(thread.updatedAt)}
          </span>
        </span>
        {passage === undefined ? null : (
          <span className="line-clamp-2 text-meta leading-relaxed text-fg-tertiary max-md:text-[13px]">
            <Marked pieces={passage} />
          </span>
        )}
      </span>
    </>
  );
}

/** A project file: its name, matched words set apart, then the folder it's in. */
function FileRow({ path, words }: { path: string; words: ReadonlyArray<string> }) {
  const dir = dirOf(path);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2.5" title={path}>
      <FileIcon path={path} className="size-3.5 shrink-0" />
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="max-w-full shrink-0 truncate text-body text-fg-secondary max-md:text-[15px]">
          <Marked pieces={highlight(nameOf(path), words)} />
        </span>
        {dir === "" ? null : (
          <span className="min-w-0 truncate text-meta text-fg-tertiary max-md:text-[13px]">
            <Marked pieces={highlight(dir, words)} />
          </span>
        )}
      </span>
    </span>
  );
}

/** A key as the palette's footer names it. */
function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded border border-line-subtle bg-surface-raised px-1 font-sans text-caption leading-4 text-fg-secondary">
      {children}
    </kbd>
  );
}

/** Text with the words that matched set apart. */
function Marked({ pieces }: { pieces: ReadonlyArray<Piece> }) {
  return pieces.map((piece, index) =>
    piece.match ? (
      <mark key={index} className="rounded bg-accent-soft px-px text-fg-primary">
        {piece.text}
      </mark>
    ) : (
      <Fragment key={index}>{piece.text}</Fragment>
    ),
  );
}
