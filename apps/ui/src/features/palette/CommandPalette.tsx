import { Autocomplete } from "@base-ui/react/autocomplete";
import { Dialog } from "@base-ui/react/dialog";
import type { ThreadMatch } from "@cerium/rpc";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { Archive, Monitor, Search, X } from "lucide-react";
import { Fragment, useState } from "react";

import { threadSearchAtom, threadSearchKey } from "../../backend/search.ts";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { keyLabel } from "../../lib/keys.ts";
import { shortAgo } from "../../lib/time.ts";
import type { ThreadSummary } from "../threads/model.ts";
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
import { paletteGroups, type PaletteCommand, type PaletteEntry, type PaletteGroup } from "./palette.ts";

const noMatches: Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<ThreadMatch>, unknown>> = Atom.make(
  AsyncResult.success<ReadonlyArray<ThreadMatch>>([]),
);

/** How many recent threads the palette offers before anything is typed. */
const RECENT = 4;

const hitOf = ({ threadId, passage }: ThreadMatch): MessageHit => ({ threadId, passage });

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly mode: "work" | "chat";
  /** Every thread of the mode, archived ones too. */
  readonly threads: ReadonlyArray<ThreadSummary>;
  /** Whether the machine the window drives can search messages; older ones are searched by title. */
  readonly messageSearch: boolean;
  readonly onOpenThread: (threadId: string) => void;
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
        <Dialog.Backdrop className="fixed inset-0 bg-scrim transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Viewport className="fixed inset-0 flex items-start justify-center px-2 pt-[12vh] pb-2 max-md:pt-[max(0.5rem,env(safe-area-inset-top))]">
          <Dialog.Popup
            aria-label="Command palette"
            className="flex max-h-[min(34rem,calc(100dvh-5rem))] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line-subtle bg-surface-overlay text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale,translate] duration-150 ease-out-soft outline-none data-ending-style:-translate-y-2 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:-translate-y-2 data-starting-style:scale-[0.98] data-starting-style:opacity-0"
          >
            <PalettePanel
              {...panel}
              onOpenThread={(threadId) => {
                onOpenChange(false);
                panel.onOpenThread(threadId);
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
  commands,
  onRun,
}: Omit<CommandPaletteProps, "open" | "onOpenChange"> & {
  readonly onRun: (command: PaletteCommand) => void;
}) {
  const [typed, setTyped] = useState("");
  const query = typed.trim();
  const asking = messageSearch && queryWords(query).length > 0 && query.length >= MIN_MESSAGE_QUERY;
  const found = useAtomValue(asking ? threadSearchAtom(threadSearchKey(mode, query)) : noMatches);
  // While a longer query is looked up, the last answer stays, so the list doesn't empty between keystrokes.
  const [kept, setKept] = useState<ReadonlyArray<ThreadMatch>>([]);
  if (asking && AsyncResult.isSuccess(found) && found.value !== kept) setKept(found.value);
  if (!asking && kept.length > 0) setKept([]);
  const answered = asking && AsyncResult.isSuccess(found);
  // A failed lookup shows no message matches rather than the last query's.
  const failed = asking && AsyncResult.isFailure(found);
  const hits = !asking || failed ? [] : (answered ? found.value : kept).map(hitOf);
  const results = searchResults(threads, query, hits);
  // Nothing typed lists fewer recent threads, to leave the actions below them in view.
  const groups = paletteGroups(
    query === "" ? results.slice(0, RECENT) : results,
    commands,
    query,
    mode === "work" ? "Threads" : "Chats",
  );
  const looking = asking && !answered && !failed;
  const note = !messageSearch
    ? query === ""
      ? undefined
      : "Update Cerium on that computer to search messages."
    : failed
      ? "Couldn't search messages."
      : looking
        ? "Searching messages…"
        : undefined;
  const words = queryWords(query);
  const noun = mode === "work" ? "threads" : "chats";
  // A project's name is only worth a result's room when the threads span more than one.
  const projects = new Set(threads.map((thread) => thread.folder)).size > 1;

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
      itemToStringValue={(entry: PaletteEntry) =>
        entry.kind === "thread" ? entry.result.thread.title : entry.command.label
      }
    >
      <Autocomplete.InputGroup className="flex shrink-0 items-center gap-2.5 border-b border-line-subtle pr-2 pl-3.5">
        <Search size={15} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" aria-hidden />
        <Autocomplete.Input
          aria-label={mode === "work" ? "Search threads and commands" : "Search chats and commands"}
          placeholder={`Search ${noun}, settings and actions`}
          className="h-12 min-w-0 flex-1 bg-transparent text-[14px] text-fg-primary outline-none placeholder:text-fg-tertiary max-md:text-base"
        />
        <Dialog.Close
          aria-label="Close search"
          className="hidden size-9 shrink-0 place-items-center rounded-lg text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary max-md:grid"
        >
          <X size={16} strokeWidth={1.75} />
        </Dialog.Close>
      </Autocomplete.InputGroup>

      {groups.length === 0 ? (
        <output className="block px-4 py-8 text-center text-[13px] text-fg-tertiary max-md:text-[15px]">
          {query === "" ? `No ${noun} yet.` : (note ?? `Nothing matches.`)}
        </output>
      ) : (
        <ScrollArea
          className="flex-1"
          viewportClassName="max-h-[min(24rem,calc(100dvh-10rem))] max-md:max-h-[min(26rem,calc(100dvh-20rem))]"
        >
          <Autocomplete.List className="flex flex-col p-1.5 outline-none">
            {(group: PaletteGroup) => (
              <Autocomplete.Group key={group.value} items={group.items} className="flex flex-col gap-px">
                <Autocomplete.GroupLabel className="px-2 pt-2 pb-0.5 text-xs font-medium text-fg-secondary/80 first:pt-1">
                  {group.value}
                </Autocomplete.GroupLabel>
                <Autocomplete.Collection>
                  {(entry: PaletteEntry) => (
                    <Autocomplete.Item
                      key={entry.key}
                      value={entry}
                      onClick={() =>
                        entry.kind === "thread" ? onOpenThread(entry.result.thread.id) : onRun(entry.command)
                      }
                      className="flex cursor-default items-start gap-2.5 rounded-lg px-2 py-1.5 outline-none select-none [scroll-margin-block:0.375rem] data-highlighted:bg-surface-active max-md:gap-3 max-md:py-2.5"
                    >
                      {entry.kind === "thread" ? (
                        <ResultRow result={entry.result} words={words} projects={projects} />
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
      {groups.length > 0 && note !== undefined ? (
        <output className="block shrink-0 border-t border-line-subtle px-4 py-2 text-xs text-fg-tertiary">
          {note}
        </output>
      ) : null}
    </Autocomplete.Root>
  );
}

function CommandRow({ command, words }: { command: PaletteCommand; words: ReadonlyArray<string> }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2.5">
      <command.icon size={14} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[13px] text-fg-secondary max-md:text-[15px]">
        <Marked pieces={highlight(command.label, words)} />
      </span>
      {command.keys ? (
        <kbd className="shrink-0 font-sans text-2xs text-fg-tertiary max-md:hidden">
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
            className={`min-w-0 flex-1 truncate text-[13px] max-md:text-[15px] ${thread.unread ? "font-medium text-fg-primary" : "text-fg-secondary"}`}
          >
            <Marked pieces={highlight(thread.title, words)} />
          </span>
          {projects && thread.project ? (
            <span className="max-w-[35%] shrink-0 truncate text-2xs text-fg-tertiary max-md:text-xs">
              {thread.project}
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
          <span className="w-6 shrink-0 text-right text-2xs text-fg-tertiary tabular-nums max-md:text-xs">
            {shortAgo(thread.updatedAt)}
          </span>
        </span>
        {passage === undefined ? null : (
          <span className="line-clamp-2 text-xs leading-relaxed text-fg-tertiary max-md:text-[13px]">
            <Marked pieces={passage} />
          </span>
        )}
      </span>
    </>
  );
}

/** Text with the words that matched set apart. */
function Marked({ pieces }: { pieces: ReadonlyArray<Piece> }) {
  return pieces.map((piece, index) =>
    piece.match ? (
      <mark key={index} className="rounded-xs bg-accent-soft px-px text-fg-primary">
        {piece.text}
      </mark>
    ) : (
      <Fragment key={index}>{piece.text}</Fragment>
    ),
  );
}
