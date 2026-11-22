import { ChevronRight } from "lucide-react";
import { useEffect, useEffectEvent } from "react";

import { Sheet } from "../../components/ui/Sheet.tsx";
import { shortAgo } from "../../lib/time.ts";
import { isListed, type ThreadSummary } from "./model.ts";
import { ThreadMark } from "./StatusIndicator.tsx";

/** How long "All caught up." stands before the emptied sheet closes. */
export const CAUGHT_UP_CLOSE = 300;

/**
 * The threads waiting on an approval, in the order `nextWaitingThread` steps through them: those
 * after the open one first, wrapping around, and the open one, if it waits too, last.
 */
export const triageThreads = (
  threads: ReadonlyArray<ThreadSummary>,
  current: string | undefined,
): ReadonlyArray<ThreadSummary> => {
  const waiting = threads
    .filter((thread) => isListed(thread) && thread.status === "awaitingApproval")
    .toSorted((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const index = waiting.findIndex((thread) => thread.id === current);
  return index === -1 ? waiting : [...waiting.slice(index + 1), ...waiting.slice(0, index + 1)];
};

/**
 * Every thread waiting on the user, across projects and machines, as a bottom sheet. A row closes
 * the sheet and opens its thread, where the request is answered with its context in view. Once
 * none wait it says so and closes.
 */
export function TriageSheet({
  open,
  onOpenChange,
  threads,
  current,
  onOpen,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threads: ReadonlyArray<ThreadSummary>;
  /** The thread open in the pane, listed last and marked when it waits too. */
  current?: string | undefined;
  onOpen: (threadId: string) => void;
}) {
  const rows = triageThreads(threads, current);
  const empty = rows.length === 0;
  const close = useEffectEvent(() => onOpenChange(false));
  useEffect(() => {
    if (!open || !empty) return;
    const timer = setTimeout(close, CAUGHT_UP_CLOSE);
    return () => clearTimeout(timer);
  }, [open, empty]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Waiting for you">
      {empty ? (
        <output className="block px-3 pt-2 pb-4 text-[15px] text-fg-secondary">All caught up.</output>
      ) : (
        <ul className="flex flex-col pb-1">
          {rows.map((thread) => (
            <li key={thread.id}>
              <TriageRow
                thread={thread}
                current={thread.id === current}
                onOpen={() => {
                  onOpenChange(false);
                  onOpen(thread.id);
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

function TriageRow({
  thread,
  current,
  onOpen,
}: {
  thread: ThreadSummary;
  current: boolean;
  onOpen: () => void;
}) {
  const machine = thread.machine;
  const offline = thread.elsewhere?.online === false;
  const where = [thread.project, machine].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={current ? "page" : undefined}
      className={`flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2 text-left outline-none select-none transition-colors active:bg-surface-active focus-visible:ring-2 focus-visible:ring-focus-ring ${
        current ? "bg-surface-selected" : ""
      }`}
    >
      <ThreadMark thread={thread} unread={thread.unread} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-fg-primary">
            {thread.title}
          </span>
          <time
            dateTime={new Date(thread.updatedAt).toISOString()}
            className="shrink-0 text-[13px] text-fg-tertiary tabular-nums"
          >
            {shortAgo(thread.updatedAt)}
          </time>
        </span>
        <span className="min-w-0 truncate text-[13px] text-fg-tertiary">
          <span className="font-medium text-attention-text">Needs you</span>
          {where ? ` · ${where}` : ""}
          {offline ? " · Offline" : ""}
        </span>
      </span>
      <ChevronRight size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-fg-tertiary" />
    </button>
  );
}
