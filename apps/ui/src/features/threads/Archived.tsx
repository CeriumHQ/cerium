import { Collapsible } from "@base-ui/react/collapsible";
import { ArchiveRestore, ChevronRight, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";

import { MenuItem, MenuSeparator } from "../../components/ui/Menu.tsx";
import { ScrollArea } from "../../components/ui/ScrollArea.tsx";
import { remember, stored } from "../../lib/storage.ts";
import { canDelete, type ThreadSummary } from "./model.ts";
import { type RenameThread } from "./Rename.tsx";
import { ThreadRow, type RowMark } from "./ThreadRow.tsx";

const OPEN_KEY = "cerium:archivedOpen";

export interface ArchivedActions {
  readonly selectedId: string | undefined;
  /** How the inbox leads its rows, so these match. */
  readonly mark: RowMark;
  readonly harness: boolean;
  /** Opens the thread; `newTab` keeps it in a tab of its own rather than the preview. */
  readonly onSelect: (threadId: string, newTab?: boolean) => void;
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
      <Collapsible.Trigger className="group flex w-full shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-fg-secondary/80 transition-colors hover:text-fg-primary max-md:py-2 max-md:text-[13px]">
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
  mark,
  harness,
  onSelect,
  onRename,
  onRestore,
  onDelete,
}: { thread: ThreadSummary } & ArchivedActions) {
  return (
    <ThreadRow
      thread={thread}
      selected={thread.id === selectedId}
      mark={mark}
      harness={harness}
      quiet
      onSelect={onSelect}
      onRename={onRename}
      onDelete={onDelete}
      menu={({ rename, remove }) => (
        <>
          <MenuItem icon={ArchiveRestore} onClick={() => onRestore(thread.id)}>
            Restore
          </MenuItem>
          <MenuItem icon={Pencil} onClick={rename}>
            Rename
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={Trash2} tone="danger" disabled={!canDelete(thread)} onClick={remove}>
            Delete
          </MenuItem>
        </>
      )}
    />
  );
}
