import { Button } from "@base-ui/react/button";
import type { ThreadId } from "@cerium/protocol";
import type { ThreadOverview } from "@cerium/rpc";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Archive, ArchiveRestore, MessageSquare, Trash2 } from "lucide-react";
import { useState } from "react";

import { deleteThread, setThreadArchived, threadsAtom } from "../../backend/atoms.ts";
import { toThreadSummary } from "../../backend/view.ts";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { whenAgo } from "../../lib/time.ts";
import { DeleteThreadDialog } from "../threads/Delete.tsx";
import { archivedThreads, canDelete, type ThreadSummary } from "../threads/model.ts";
import { ProjectBadge } from "../threads/ProjectBadge.tsx";
import { SettingsPage } from "./parts.tsx";

export function ArchivedSettings() {
  const overviews = AsyncResult.getOrElse(useAtomValue(threadsAtom), (): ReadonlyArray<ThreadOverview> => []);
  const refresh = useAtomRefresh(threadsAtom);
  const archive = useAtomSet(setThreadArchived, { mode: "promise" });
  const remove = useAtomSet(deleteThread, { mode: "promise" });
  const [error, setError] = useState<string>();

  const restore = (threadId: string) => {
    setError(undefined);
    void archive({ payload: { threadId: threadId as ThreadId, archived: false } }).then(refresh, () =>
      setError("Couldn't restore it. Try again in a moment."),
    );
  };

  const deleteForGood = (threadId: string) => {
    setError(undefined);
    void remove({ payload: { threadId: threadId as ThreadId } }).then(refresh, () =>
      setError("Couldn't delete it. Try again in a moment."),
    );
  };

  return (
    <SettingsPage perMachine title="Archived">
      <ArchivedView
        threads={archivedThreads(overviews.map(toThreadSummary))}
        {...(error === undefined ? {} : { error })}
        onRestore={restore}
        onDelete={deleteForGood}
      />
    </SettingsPage>
  );
}

/** The archived threads and chats, most recently archived first, each with its restore and delete. */
export function ArchivedView({
  threads,
  error,
  onRestore,
  onDelete,
}: {
  threads: ReadonlyArray<ThreadSummary>;
  error?: string;
  onRestore: (threadId: string) => void;
  onDelete: (threadId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {error ? <p className="text-[12.5px] text-error">{error}</p> : null}
      {threads.length === 0 ? (
        <div className="flex items-start gap-3 py-2 text-[13px] leading-relaxed text-fg-tertiary">
          <Archive size={16} strokeWidth={1.5} className="mt-0.5 shrink-0" />
          <p>Nothing archived. Right-click a thread or chat in the sidebar to archive it.</p>
        </div>
      ) : (
        <ul className="divide-y divide-line-subtle rounded-xl border border-line-subtle">
          {threads.map((thread) => (
            <li key={thread.id}>
              <ArchivedRow
                thread={thread}
                onRestore={() => onRestore(thread.id)}
                onDelete={() => onDelete(thread.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ArchivedRow({
  thread,
  onRestore,
  onDelete,
}: {
  thread: ThreadSummary;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="group/archived flex items-center gap-3 py-2.5 pr-3 pl-4">
      {thread.folder && thread.project ? (
        <ProjectBadge folder={thread.folder} name={thread.project} />
      ) : (
        <span className="grid size-4.5 shrink-0 place-items-center text-fg-tertiary">
          <MessageSquare size={15} strokeWidth={1.75} aria-hidden />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] text-fg-primary" title={thread.title}>
          {thread.title}
        </span>
        <span className="truncate text-xs text-fg-tertiary">
          {thread.project ?? "Chat"} · {whenAgo(thread.archivedAt ?? 0)}
        </span>
      </div>
      <Button
        onClick={onRestore}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line-subtle px-2.5 text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
      >
        <ArchiveRestore size={13} strokeWidth={1.75} />
        Restore
      </Button>
      {/* Delete stays out of the way until the row is hovered or focused; a touch screen always shows it. */}
      <Tooltip label="Delete">
        <Button
          onClick={() => setDeleting(true)}
          disabled={!canDelete(thread)}
          aria-label={`Delete ${thread.title}`}
          className="grid size-7 shrink-0 place-items-center rounded-md text-fg-tertiary opacity-0 transition-[opacity,background-color,color] duration-150 group-focus-within/archived:opacity-100 group-hover/archived:opacity-100 hover:bg-error/15 hover:text-error focus-visible:opacity-100 disabled:pointer-events-none pointer-coarse:opacity-100"
        >
          <Trash2 size={13} strokeWidth={1.75} />
        </Button>
      </Tooltip>
      <DeleteThreadDialog thread={thread} open={deleting} onOpenChange={setDeleting} onConfirm={onDelete} />
    </div>
  );
}
