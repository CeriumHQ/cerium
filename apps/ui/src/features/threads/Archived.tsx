import { Button } from "@base-ui/react/button";
import { Collapsible } from "@base-ui/react/collapsible";
import { ArchiveRestore, ChevronRight, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { ContextMenuArea, MenuItem, MenuSeparator } from "../../components/ui/Menu.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { remember, stored } from "../../lib/storage.ts";
import { shortAgo } from "../../lib/time.ts";
import { DeleteThreadDialog } from "./Delete.tsx";
import { canDelete, type ThreadSummary } from "./model.ts";
import { TitleField, useRename, type RenameThread } from "./Rename.tsx";

const OPEN_KEY = "cerium:archivedOpen";

export interface ArchivedActions {
  readonly selectedId: string | undefined;
  readonly onSelect: (threadId: string) => void;
  readonly onRename: RenameThread;
  readonly onRestore: (threadId: string) => void;
  readonly onDelete: (threadId: string) => void;
}

/** Archived work threads, folded away at the foot of the sidebar; nothing when there are none. */
export function ArchivedSection({
  threads,
  ...actions
}: { threads: ReadonlyArray<ThreadSummary> } & ArchivedActions) {
  const [open, setOpen] = useState(() => stored(OPEN_KEY) === "true");
  if (threads.length === 0) return null;
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={(next) => {
        remember(OPEN_KEY, String(next));
        setOpen(next);
      }}
      className="flex max-h-[45%] shrink-0 flex-col border-t border-line-subtle px-2 pt-1.5 pb-1"
    >
      <Collapsible.Trigger className="group flex w-full shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-fg-secondary/80 transition-colors hover:text-fg-primary">
        <ChevronRight
          size={12}
          strokeWidth={2}
          className="transition-transform duration-200 ease-out-soft group-data-panel-open:rotate-90"
        />
        Archived
        <span className="text-fg-tertiary tabular-nums">{threads.length}</span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="flex h-(--collapsible-panel-height) min-h-0 flex-col overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0">
        <ScrollArea className="min-h-0 flex-1">
          <ul className="flex flex-col gap-px pt-0.5" aria-label="Archived threads">
            {threads.map((thread) => (
              <li key={thread.id}>
                <ArchivedRow thread={thread} {...actions} />
              </li>
            ))}
          </ul>
        </ScrollArea>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function ArchivedRow({
  thread,
  selectedId,
  onSelect,
  onRename,
  onRestore,
  onDelete,
}: { thread: ThreadSummary } & ArchivedActions) {
  const selected = thread.id === selectedId;
  const [deleting, setDeleting] = useState(false);
  const { editing, start, finish, title, row } = useRename(thread, onRename);
  const rowClass = `flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-150 data-popup-open:bg-surface-hover ${
    selected || editing
      ? "bg-surface-selected text-fg-primary"
      : "text-fg-tertiary hover:bg-surface-hover hover:text-fg-primary"
  }`;
  const titleClass = "min-w-0 flex-1 truncate";
  const providers = [...new Set(thread.providers)];
  const content = (
    <>
      <span className="flex shrink-0 items-center gap-0.5" aria-label={`${providers.length} harnesses`}>
        {providers.map((provider) => (
          <ProviderLogo key={provider} provider={provider} size={12} />
        ))}
      </span>
      {editing ? (
        <TitleField title={thread.title} onDone={finish} className={`-mx-1 h-6 ${titleClass}`} />
      ) : (
        <span className={titleClass}>{title}</span>
      )}
      <span className="shrink-0 text-2xs text-fg-tertiary tabular-nums">{shortAgo(thread.updatedAt)}</span>
    </>
  );

  // While renaming, the row is a field rather than a button, and right-clicks get the text menu.
  if (editing) return <div className={rowClass}>{content}</div>;
  return (
    <>
      <ContextMenuArea
        menu={
          <>
            <MenuItem icon={ArchiveRestore} onClick={() => onRestore(thread.id)}>
              Restore
            </MenuItem>
            <MenuItem icon={Pencil} onClick={start}>
              Rename
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
