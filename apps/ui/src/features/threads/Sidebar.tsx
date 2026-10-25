import { Button } from "@base-ui/react/button";
import { Collapsible } from "@base-ui/react/collapsible";
import type { ProviderId } from "@cerium/protocol";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  Archive,
  ChevronRight,
  MessagesSquare,
  Pencil,
  Pin,
  PinOff,
  Search,
  SquarePen,
  Trash2,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef } from "react";

import { IconButton } from "../../components/ui/IconButton.tsx";
import { MenuItem, MenuSeparator } from "../../components/ui/Menu.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { keyLabel, primaryHeld } from "../../lib/keys.ts";
import { newThreadDraftsAtom, type NewThreadDraft } from "../composer/drafts.ts";
import { CommandPalette } from "../palette/CommandPalette.tsx";
import type { PaletteCommand } from "../palette/palette.ts";
import { DraftSection, type DraftActions, type DraftMachine } from "./DraftRow.tsx";
import { chatSections, type ThreadSection } from "./sections.ts";
import { EmptyList } from "./EmptyList.tsx";
import { Inbox } from "./Inbox.tsx";
import { archivedWork, canArchive, canDelete, isListed, type ThreadSummary } from "./model.ts";
import { type RenameThread } from "./Rename.tsx";
import { pinnedAtom, togglePin, withPinned } from "./pins.ts";
import { ThreadRow } from "./ThreadRow.tsx";

interface SidebarProps {
  /** Only this mode's threads are listed. */
  readonly mode: "work" | "chat";
  readonly threads: ReadonlyArray<ThreadSummary>;
  /** The open thread, or the open draft of a thread not started yet. */
  readonly selectedId: string | undefined;
  /** Opens the thread; `newTab` keeps it in a tab of its own rather than the preview. */
  readonly onSelect: (threadId: string, newTab?: boolean) => void;
  readonly onSelectDraft: (draft: NewThreadDraft, newTab?: boolean) => void;
  readonly onDiscardDraft: (key: string) => void;
  readonly draftMachine: DraftMachine;
  readonly onNewThread: () => void;
  readonly onMarkRead: (threads: ReadonlyArray<ThreadSummary>) => void;
  readonly onMarkUnread: (threadId: string) => void;
  /** Opens a new work thread in the folder, ready to type. */
  readonly onNewThreadIn: (folder: string) => void;
  readonly onRename: RenameThread;
  readonly onArchive: (threadId: string) => void;
  readonly onRestore: (threadId: string) => void;
  /** Puts a work thread off until then, or brings it back; absent where the machine can't. */
  readonly onLater?: (threadId: string, until: number | undefined) => void;
  /** The threads open in tabs. */
  readonly open?: ReadonlyArray<string>;
  /** Deletes a thread for good, once the user has confirmed it. */
  readonly onDelete: (threadId: string) => void;
  /** The command palette: opened by its button here and by Ctrl K, which the window listens for. */
  readonly searchOpen: boolean;
  readonly onSearchOpenChange: (open: boolean) => void;
  /** What the palette can run besides opening a thread. */
  readonly commands: ReadonlyArray<PaletteCommand>;
  /** Whether the machine the window drives can search what was said in threads, or only their titles. */
  readonly messageSearch: boolean;
}

export interface HarnessIndicator {
  readonly provider: ProviderId;
  readonly state: "ready" | "loggedOut" | "missing" | "unsupported";
  /** Ready, but some access modes can't run commands until a one-time setup (Settings → Harnesses). */
  readonly needsSetup?: boolean;
}

export function Sidebar({
  mode,
  threads,
  selectedId,
  onSelect,
  onSelectDraft,
  onDiscardDraft,
  draftMachine,
  onNewThread,
  onMarkRead,
  onMarkUnread,
  onNewThreadIn,
  onRename,
  onArchive,
  onRestore,
  onLater,
  open = [],
  onDelete,
  searchOpen,
  onSearchOpenChange,
  commands,
  messageSearch,
}: SidebarProps) {
  const modeThreads = threads.filter((thread) => thread.mode === mode && isListed(thread));
  // Read here rather than by the window, so writing a draft's first line re-renders only the list.
  const drafts = useAtomValue(newThreadDraftsAtom).filter((draft) => draft.mode === mode);
  const draftActions: DraftActions = { selectedId, onSelectDraft, onDiscardDraft, draftMachine };

  // Ctrl 1 to 9 open the list's first nine rows and Ctrl 0 its tenth, counted as the list shows them:
  // its scope, its sections and its folded groups decide, so the rendered rows are what's counted.
  const root = useRef<HTMLDivElement>(null);
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (!primaryHeld(event) || event.shiftKey || event.altKey || searchOpen) return;
    const digit = /^Digit(\d)$/.exec(event.code)?.[1];
    if (digit === undefined) return;
    event.preventDefault();
    const rows = root.current?.querySelectorAll<HTMLElement>("nav [data-thread], nav [data-draft]");
    const row = rows?.[digit === "0" ? 9 : Number(digit) - 1];
    if (row?.dataset.thread !== undefined) onSelect(row.dataset.thread);
    const draft = drafts.find((candidate) => candidate.key === row?.dataset.draft);
    if (draft) onSelectDraft(draft);
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  return (
    <div ref={root} className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-2 pt-1 pb-3">
        <Button
          onClick={onNewThread}
          className="flex h-8 flex-1 items-center gap-2 rounded-lg border border-line-subtle bg-surface-raised px-2.5 text-[13px] font-medium text-fg-primary shadow-raised transition-colors duration-150 hover:bg-surface-panel active:bg-surface-active max-md:h-10 max-md:gap-2.5 max-md:rounded-xl max-md:px-3 max-md:text-[15px]"
        >
          <SquarePen size={14} strokeWidth={1.75} className="text-fg-secondary max-md:size-4" />
          {mode === "work" ? "New thread" : "New chat"}
          <kbd className="ml-auto font-sans text-2xs text-fg-tertiary max-md:hidden">
            {keyLabel("Ctrl N")}
          </kbd>
        </Button>
        <IconButton
          icon={Search}
          label="Search and commands"
          shortcut="Ctrl K"
          onClick={() => onSearchOpenChange(true)}
          className="max-md:size-10"
        />
      </div>

      {mode === "work" ? (
        <Inbox
          threads={modeThreads}
          drafts={drafts}
          draftActions={draftActions}
          archived={archivedWork(threads)}
          open={open}
          selectedId={selectedId}
          onSelect={onSelect}
          onMarkRead={onMarkRead}
          onMarkUnread={onMarkUnread}
          onNewThreadIn={onNewThreadIn}
          onRename={onRename}
          onArchive={onArchive}
          onRestore={onRestore}
          onLater={onLater}
          onDelete={onDelete}
        />
      ) : (
        <ChatList
          threads={modeThreads}
          drafts={drafts}
          draftActions={draftActions}
          selectedId={selectedId}
          onSelect={onSelect}
          onRename={onRename}
          onArchive={onArchive}
          onDelete={onDelete}
        />
      )}

      <CommandPalette
        open={searchOpen}
        onOpenChange={onSearchOpenChange}
        mode={mode}
        threads={threads.filter((thread) => thread.mode === mode)}
        messageSearch={messageSearch}
        onOpenThread={onSelect}
        commands={commands}
      />
    </div>
  );
}

interface ChatActions {
  readonly selectedId: string | undefined;
  /** Opens the thread; `newTab` keeps it in a tab of its own rather than the preview. */
  readonly onSelect: (threadId: string, newTab?: boolean) => void;
  readonly onRename: RenameThread;
  readonly onArchive: (threadId: string) => void;
  readonly onDelete: (threadId: string) => void;
}

/** Chats grouped by how recent they are, under the drafts of chats not started yet. */
function ChatList({
  threads,
  drafts,
  draftActions,
  ...actions
}: {
  threads: ReadonlyArray<ThreadSummary>;
  drafts: ReadonlyArray<NewThreadDraft>;
  draftActions: DraftActions;
} & ChatActions) {
  const sections = withPinned(chatSections(threads), useAtomValue(pinnedAtom));
  return (
    <ScrollArea className="flex-1">
      <nav className="flex flex-col gap-3 px-2 pb-3" aria-label="Chats">
        <DraftSection drafts={drafts} list="chat" mark="dot" {...draftActions} />
        {sections.map((section) => (
          <ChatGroup key={section.key} section={section} {...actions} />
        ))}
        {sections.length === 0 && drafts.length === 0 ? (
          <EmptyList icon={MessagesSquare} title="No chats yet" hint="Your conversations are kept here." />
        ) : null}
      </nav>
    </ScrollArea>
  );
}

function ChatGroup({ section, selectedId, ...actions }: { section: ThreadSection } & ChatActions) {
  return (
    <Collapsible.Root defaultOpen>
      <Collapsible.Trigger className="group flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-fg-secondary/80 transition-colors hover:text-fg-primary max-md:py-2 max-md:text-[13px]">
        <ChevronRight
          size={12}
          strokeWidth={2}
          className="transition-transform duration-200 ease-out-soft group-data-panel-open:rotate-90"
        />
        {section.label}
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0">
        <ul className="flex flex-col gap-px pt-0.5">
          {section.threads.map((thread) => (
            <li key={thread.id}>
              <ChatRow thread={thread} selected={thread.id === selectedId} {...actions} />
            </li>
          ))}
        </ul>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function ChatRow({
  thread,
  selected,
  onSelect,
  onRename,
  onArchive,
  onDelete,
}: { thread: ThreadSummary; selected: boolean } & Omit<ChatActions, "selectedId">) {
  const pins = useAtomValue(pinnedAtom);
  const setPins = useAtomSet(pinnedAtom);
  const pinned = pins.includes(thread.id);
  return (
    <ThreadRow
      thread={thread}
      selected={selected}
      mark="dot"
      harness={false}
      onSelect={onSelect}
      onRename={onRename}
      onDelete={onDelete}
      // Another machine's chat is renamed, archived or deleted there, so its row has no menu here.
      {...(thread.elsewhere
        ? {}
        : {
            menu: ({ rename, remove }) => (
              <>
                <MenuItem icon={pinned ? PinOff : Pin} onClick={() => setPins(togglePin(pins, thread.id))}>
                  {pinned ? "Unpin" : "Pin"}
                </MenuItem>
                <MenuItem icon={Pencil} onClick={rename}>
                  Rename
                </MenuItem>
                <MenuItem icon={Archive} disabled={!canArchive(thread)} onClick={() => onArchive(thread.id)}>
                  Archive
                </MenuItem>
                <MenuSeparator />
                <MenuItem icon={Trash2} tone="danger" disabled={!canDelete(thread)} onClick={remove}>
                  Delete
                </MenuItem>
              </>
            ),
          })}
    />
  );
}
