import { Button } from "@base-ui/react/button";
import { Collapsible } from "@base-ui/react/collapsible";
import type { ProviderId } from "@cerium/protocol";
import { Archive, ChevronRight, Pencil, Search, Settings, SquarePen, Trash2, Monitor } from "lucide-react";
import { useState } from "react";

import { IconButton } from "../../components/ui/IconButton.tsx";
import { ContextMenuArea, MenuItem, MenuSeparator } from "../../components/ui/Menu.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { shortAgo } from "../../lib/time.ts";
import type { SettingsCategory } from "../settings/Settings.tsx";
import { chatSections, type ThreadSection } from "./sections.ts";
import { Inbox } from "./Inbox.tsx";
import { DeleteThreadDialog } from "./Delete.tsx";
import { archivedWork, canArchive, canDelete, isListed, providerName, type ThreadSummary } from "./model.ts";
import { TitleField, useRename, type RenameThread } from "./Rename.tsx";
import { ProviderStack, StatusIndicator } from "./StatusIndicator.tsx";

interface SidebarProps {
  /** Only this mode's threads are listed. */
  readonly mode: "work" | "chat";
  readonly threads: ReadonlyArray<ThreadSummary>;
  readonly selectedId: string | undefined;
  readonly onSelect: (threadId: string) => void;
  readonly onNewThread: () => void;
  readonly onMarkRead: (threads: ReadonlyArray<ThreadSummary>) => void;
  readonly onMarkUnread: (threadId: string) => void;
  /** Opens a new work thread in the folder, ready to type. */
  readonly onNewThreadIn: (folder: string) => void;
  readonly onRename: RenameThread;
  readonly onArchive: (threadId: string) => void;
  readonly onRestore: (threadId: string) => void;
  /** Deletes a thread for good, once the user has confirmed it. */
  readonly onDelete: (threadId: string) => void;
  readonly harnesses: ReadonlyArray<HarnessIndicator>;
  readonly onOpenSettings: (category?: SettingsCategory) => void;
}

export interface HarnessIndicator {
  readonly provider: ProviderId;
  readonly state: "ready" | "loggedOut" | "missing" | "unsupported";
}

export function Sidebar({
  mode,
  threads,
  selectedId,
  onSelect,
  onNewThread,
  onMarkRead,
  onMarkUnread,
  onNewThreadIn,
  onRename,
  onArchive,
  onRestore,
  onDelete,
  harnesses,
  onOpenSettings,
}: SidebarProps) {
  const modeThreads = threads.filter((thread) => thread.mode === mode && isListed(thread));
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-2 pb-2">
        <Button
          onClick={onNewThread}
          className="flex h-8 flex-1 items-center gap-2 rounded-lg border border-line-subtle bg-surface-raised px-2.5 text-[13px] font-medium text-fg-primary shadow-raised transition-colors duration-150 hover:bg-surface-panel active:bg-surface-active"
        >
          <SquarePen size={14} strokeWidth={1.75} className="text-fg-secondary" />
          {mode === "work" ? "New thread" : "New chat"}
          <kbd className="ml-auto font-sans text-2xs text-fg-tertiary">Ctrl N</kbd>
        </Button>
        <IconButton
          icon={Search}
          label={mode === "work" ? "Search threads" : "Search chats"}
          shortcut="Ctrl K"
        />
      </div>

      {mode === "work" ? (
        <Inbox
          threads={modeThreads}
          archived={archivedWork(threads)}
          selectedId={selectedId}
          onSelect={onSelect}
          onMarkRead={onMarkRead}
          onMarkUnread={onMarkUnread}
          onNewThreadIn={onNewThreadIn}
          onRename={onRename}
          onArchive={onArchive}
          onRestore={onRestore}
          onDelete={onDelete}
        />
      ) : (
        <ChatList
          threads={modeThreads}
          selectedId={selectedId}
          onSelect={onSelect}
          onRename={onRename}
          onArchive={onArchive}
          onDelete={onDelete}
        />
      )}

      <SidebarFooter harnesses={harnesses} onOpenSettings={onOpenSettings} />
    </div>
  );
}

interface ChatActions {
  readonly selectedId: string | undefined;
  readonly onSelect: (threadId: string) => void;
  readonly onRename: RenameThread;
  readonly onArchive: (threadId: string) => void;
  readonly onDelete: (threadId: string) => void;
}

/** Chats grouped by how recent they are. */
function ChatList({ threads, ...actions }: { threads: ReadonlyArray<ThreadSummary> } & ChatActions) {
  const sections = chatSections(threads);
  return (
    <ScrollArea className="flex-1">
      <nav className="flex flex-col gap-3 px-2 pb-3" aria-label="Chats">
        {sections.map((section) => (
          <ChatGroup key={section.key} section={section} {...actions} />
        ))}
        {sections.length === 0 ? (
          <p className="px-2 py-1.5 text-xs leading-relaxed text-fg-tertiary">
            Chats you start show up here, newest first.
          </p>
        ) : null}
      </nav>
    </ScrollArea>
  );
}

function ChatGroup({ section, selectedId, ...actions }: { section: ThreadSection } & ChatActions) {
  return (
    <Collapsible.Root defaultOpen>
      <Collapsible.Trigger className="group flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-fg-secondary/80 transition-colors hover:text-fg-primary">
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
              <ThreadRow thread={thread} selected={thread.id === selectedId} {...actions} />
            </li>
          ))}
        </ul>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function ThreadRow({
  thread,
  selected,
  onSelect,
  onRename,
  onArchive,
  onDelete,
}: { thread: ThreadSummary; selected: boolean } & Omit<ChatActions, "selectedId">) {
  const [deleting, setDeleting] = useState(false);
  const { editing, start, finish, title, row } = useRename(thread, onRename);
  const rowClass = `group flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-150 data-popup-open:bg-surface-hover ${
    selected || editing
      ? "bg-surface-selected text-fg-primary"
      : "text-fg-secondary hover:bg-surface-hover hover:text-fg-primary"
  }`;
  const titleClass = `min-w-0 flex-1 truncate ${thread.unread ? "font-medium text-fg-primary" : ""}`;
  const content = (
    <>
      <StatusIndicator status={thread.status} unread={thread.unread} />
      {editing ? (
        <TitleField title={thread.title} onDone={finish} className={`-mx-1 h-6 ${titleClass}`} />
      ) : (
        <span className={titleClass}>{title}</span>
      )}
      {thread.providers.length > 1 && thread.status !== "idle" && thread.status !== "failed" ? (
        <ProviderStack providers={thread.providers} />
      ) : null}
      {thread.machine ? (
        <span
          title={
            thread.elsewhere?.online === false
              ? `On ${thread.machine}, which is offline`
              : `On ${thread.machine}`
          }
          className={`shrink-0 text-fg-tertiary ${thread.elsewhere?.online === false ? "opacity-60" : ""}`}
        >
          <Monitor size={11} strokeWidth={2} aria-label={`On ${thread.machine}`} />
        </span>
      ) : null}
      <span className="w-6 shrink-0 text-right text-2xs text-fg-tertiary tabular-nums">
        {shortAgo(thread.updatedAt)}
      </span>
    </>
  );

  // While renaming, the row is a field rather than a button, and right-clicks get the text menu.
  if (editing) return <div className={rowClass}>{content}</div>;
  // Another machine's chat is renamed, archived or deleted there, so its row has no menu here.
  if (thread.elsewhere) {
    return (
      <Button
        ref={row}
        onClick={() => onSelect(thread.id)}
        aria-current={selected ? "page" : undefined}
        className={rowClass}
      >
        {content}
      </Button>
    );
  }
  return (
    <>
      <ContextMenuArea
        menu={
          <>
            <MenuItem icon={Pencil} onClick={start}>
              Rename
            </MenuItem>
            <MenuItem icon={Archive} disabled={!canArchive(thread)} onClick={() => onArchive(thread.id)}>
              Archive
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={Trash2}
              tone="danger"
              disabled={!canDelete(thread)}
              onClick={() => setDeleting(true)}
            >
              Delete
            </MenuItem>
          </>
        }
      >
        <Button
          ref={row}
          onClick={() => onSelect(thread.id)}
          aria-current={selected ? "page" : undefined}
          className={rowClass}
        >
          {content}
        </Button>
      </ContextMenuArea>
      <DeleteThreadDialog
        thread={thread}
        open={deleting}
        onOpenChange={setDeleting}
        onConfirm={() => onDelete(thread.id)}
      />
    </>
  );
}

const harnessState: Record<HarnessIndicator["state"], string> = {
  ready: "ready",
  loggedOut: "not logged in",
  missing: "not installed",
  unsupported: "not supported yet",
};

function SidebarFooter({
  harnesses,
  onOpenSettings,
}: {
  harnesses: ReadonlyArray<HarnessIndicator>;
  onOpenSettings: SidebarProps["onOpenSettings"];
}) {
  return (
    <div className="flex items-center gap-1 border-t border-line-subtle px-2 pt-1.5">
      <IconButton icon={Settings} label="Settings" shortcut="Ctrl ," onClick={() => onOpenSettings()} />
      <div className="ml-auto flex items-center gap-0.5" aria-label="Harnesses">
        {harnesses.map(({ provider, state }) => (
          <Tooltip key={provider} side="top" label={`${providerName[provider]}: ${harnessState[state]}`}>
            <Button
              onClick={() => onOpenSettings("harnesses")}
              aria-label={`${providerName[provider]} status`}
              className={`relative grid size-7 place-items-center rounded-md transition-colors hover:bg-surface-hover ${
                state === "ready" ? "text-fg-secondary hover:text-fg-primary" : "text-fg-secondary"
              }`}
            >
              {/* Colour marks dim the same way as single-colour ones when the harness can't run. */}
              <ProviderLogo
                provider={provider}
                size={14}
                {...(state === "ready" ? {} : { className: "opacity-35 grayscale" })}
              />
              {state === "loggedOut" ? (
                <span className="absolute right-1 bottom-1 size-1.5 rounded-full border border-surface-window bg-attention" />
              ) : null}
            </Button>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
