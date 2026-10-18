import { Button } from "@base-ui/react/button";
import type { ThreadId } from "@cerium/protocol";
import type { ThreadOverview } from "@cerium/rpc";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ArchiveRestore, MessageSquare } from "lucide-react";
import { useState } from "react";

import { setThreadArchived, threadsAtom } from "../../backend/atoms.ts";
import { toThreadSummary } from "../../backend/view.ts";
import { archivedThreads, type ThreadSummary } from "../threads/model.ts";
import { ProjectBadge } from "../threads/ProjectBadge.tsx";
import { SettingsCard, SettingsPage } from "./parts.tsx";

const MINUTE = 60_000;
const DAY = 86_400_000;
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/** When something happened, as people say it: "just now", "5 minutes ago", "yesterday", "on 12 Oct". */
export const whenArchived = (at: number, now = Date.now()): string => {
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return "just now";
  if (elapsed < 60 * MINUTE) return relative.format(-Math.floor(elapsed / MINUTE), "minute");
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (at >= startOfToday) return relative.format(-Math.floor(elapsed / (60 * MINUTE)), "hour");
  const days = Math.ceil((startOfToday - at) / DAY);
  if (days < 7) return relative.format(-days, "day");
  const date = new Date(at);
  return `on ${date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  })}`;
};

export function ArchivedSettings() {
  const overviews = AsyncResult.getOrElse(useAtomValue(threadsAtom), (): ReadonlyArray<ThreadOverview> => []);
  const refresh = useAtomRefresh(threadsAtom);
  const archive = useAtomSet(setThreadArchived, { mode: "promise" });
  const [error, setError] = useState<string>();
  const archived = archivedThreads(overviews.map(toThreadSummary));

  const restore = (threadId: string) => {
    setError(undefined);
    void archive({ payload: { threadId: threadId as ThreadId, archived: false } }).then(refresh, () =>
      setError("Couldn't restore it. Try again in a moment."),
    );
  };

  return (
    <SettingsPage
      title="Archived"
      description="Threads and chats you archived. Restoring one puts it back in the inbox or the chat list."
    >
      {error ? <p className="-mt-6 text-[12.5px] text-error">{error}</p> : null}
      {archived.length === 0 ? (
        <SettingsCard className="px-4 py-8 text-center text-[13px] text-fg-tertiary">
          Nothing is archived. Right-click a thread or chat in the sidebar to archive it.
        </SettingsCard>
      ) : (
        <ul className="divide-y divide-line-subtle rounded-xl border border-line-subtle">
          {archived.map((thread) => (
            <li key={thread.id}>
              <ArchivedRow thread={thread} onRestore={() => restore(thread.id)} />
            </li>
          ))}
        </ul>
      )}
    </SettingsPage>
  );
}

function ArchivedRow({ thread, onRestore }: { thread: ThreadSummary; onRestore: () => void }) {
  return (
    <div className="flex items-center gap-3 py-2.5 pr-3 pl-4">
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
          {thread.project ?? "Chat"} · Archived {whenArchived(thread.archivedAt ?? 0)}
        </span>
      </div>
      <Button
        onClick={onRestore}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line-subtle px-2.5 text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
      >
        <ArchiveRestore size={13} strokeWidth={1.75} />
        Restore
      </Button>
    </div>
  );
}
