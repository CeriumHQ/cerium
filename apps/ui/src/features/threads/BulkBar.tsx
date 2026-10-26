import { Checkbox } from "@base-ui/react/checkbox";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Archive, ArchiveRestore, Check, Clock, MailOpen, Minus, Pin, PinOff, Trash2, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { ConfirmDialog } from "../../components/ui/ConfirmDialog.tsx";
import { pinnedAtom, togglePin } from "./pins.ts";
import {
  planBulk,
  rangeSelected,
  summarizeBulk,
  toggleSelected,
  type BulkAction,
  type BulkSkip,
} from "./bulk.ts";
import { laterTime, type InboxBox, type ThreadSummary } from "./model.ts";

/** How the row toggles: alone, or a run of the list from the last one touched. */
export type SelectMode = "toggle" | "range";

/**
 * The sidebar's bulk selection: which threads are picked, across pages. The list's order lives in
 * a ref, so the toggle stays the same from one render to the next and memo'd rows don't render
 * again while another thread is picked.
 */
export function useBulkSelection(ordered: ReadonlyArray<string>) {
  const [selected, setSelected] = useState<ReadonlyArray<string>>([]);
  const anchor = useRef<string | undefined>(undefined);
  const order = useRef(ordered);
  useLayoutEffect(() => {
    order.current = ordered;
  });
  const [api] = useState(() => ({
    toggle: (id: string, mode: SelectMode) => {
      if (mode === "range") {
        const at = order.current;
        const from = anchor.current;
        setSelected((prev) => rangeSelected(at, prev, from, id));
        anchor.current = id;
      } else {
        setSelected((prev) => toggleSelected(prev, id));
        anchor.current = id;
      }
    },
    /** Ticks or unticks every id, for a run card acting as one. */
    setAll: (ids: ReadonlyArray<string>, on: boolean) => {
      const wanted = new Set(ids);
      setSelected((prev) =>
        on ? [...prev, ...ids.filter((id) => !prev.includes(id))] : prev.filter((id) => !wanted.has(id)),
      );
    },
    clear: () => {
      anchor.current = undefined;
      setSelected([]);
    },
  }));
  return { selected, ...api };
}

export type BulkSelection = ReturnType<typeof useBulkSelection>;

/**
 * A thread's tick box. It floats over the row's mark on hover, and keeps its own room on a touch
 * screen, which can't hover: the row then carries extra left padding for it. It sits beside the
 * row's own button rather than in it, so ticking never opens the thread.
 */
export function SelectBox({
  checked,
  mixed = false,
  label,
  onChange,
  className = "",
}: {
  readonly checked: boolean;
  /** Some, but not all, of a run card's threads are picked. */
  readonly mixed?: boolean;
  readonly label: string;
  readonly onChange: () => void;
  /** Where it floats, such as `left-2 top-2` on a card or `left-2 top-1/2` on a row. */
  readonly className?: string;
}) {
  const shown = checked || mixed;
  return (
    <Checkbox.Root
      checked={checked}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onAuxClick={(event) => event.stopPropagation()}
      onCheckedChange={onChange}
      aria-label={label}
      title={label}
      className={`absolute z-10 shrink-0 cursor-default rounded-[4px] outline-none select-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
        shown
          ? "opacity-100"
          : "opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100 pointer-coarse:opacity-100"
      } ${className}`}
    >
      <span
        className={`grid size-4 place-items-center rounded-[4px] border shadow-raised transition-colors ${
          shown
            ? "border-accent bg-accent text-accent-fg"
            : "border-line-strong bg-surface-overlay text-transparent hover:border-fg-tertiary"
        }`}
      >
        {mixed && !checked ? (
          <Minus size={10} strokeWidth={3} />
        ) : (
          <Checkbox.Indicator className="grid place-items-center data-unchecked:hidden">
            <Check size={10} strokeWidth={3} />
          </Checkbox.Indicator>
        )}
      </span>
    </Checkbox.Root>
  );
}

/**
 * What the sidebar offers while threads are picked: Archive, Later, Pin or Unpin, Mark read,
 * Back to Inbox (in Archive) and Delete, each running thread by thread through its row's own
 * action. Each action reports whether its threads went; whatever didn't, with why, is named in
 * the note. Delete asks first.
 */
export function BulkBar({
  box,
  threads,
  onArchive,
  onRestore,
  onLater,
  onMarkRead,
  onDelete,
  onSettled,
  onNote,
}: {
  /** Which list the picked threads are in; the chat list takes no Later or Back to Inbox. */
  readonly box: InboxBox | "chat";
  /** The picked threads of this list, in its order. */
  readonly threads: ReadonlyArray<ThreadSummary>;
  /** Each resolves whether the thread went. */
  readonly onArchive: (threadId: string) => Promise<boolean>;
  /** Brings threads back; shown only in Archive. */
  readonly onRestore: ((threadId: string) => Promise<boolean>) | undefined;
  /** Puts a thread off; absent where the machine can't. */
  readonly onLater: ((threadId: string, until: number) => Promise<boolean>) | undefined;
  readonly onMarkRead: (threads: ReadonlyArray<ThreadSummary>) => void;
  readonly onDelete: (threadId: string) => Promise<boolean>;
  /** Drops the threads an action took, so what it didn't stays picked for another try. */
  readonly onSettled: (threadIds: ReadonlyArray<string>) => void;
  readonly onNote: (note: string) => void;
}) {
  const pins = useAtomValue(pinnedAtom);
  const setPins = useAtomSet(pinnedAtom);
  const [confirming, setConfirming] = useState(false);
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const ids = threads.map((thread) => thread.id);

  /**
   * Runs `action` thread by thread through `take`, reporting what went and naming what didn't
   * with why. A thread whose call fails stays picked.
   */
  const run = async (action: BulkAction, take: (thread: ThreadSummary) => boolean | Promise<boolean>) => {
    const plan = planBulk(byId, ids, action);
    const taken: Array<ThreadSummary> = [];
    const failed: Array<BulkSkip> = [];
    for (const thread of plan.act) {
      try {
        if (await take(thread)) taken.push(thread);
        else failed.push({ id: thread.id, title: thread.title, reason: "the action failed" });
      } catch {
        failed.push({ id: thread.id, title: thread.title, reason: "the action failed" });
      }
    }
    onNote(summarizeBulk(action, { act: taken, skipped: [...plan.skipped, ...failed] }));
    onSettled(taken.map((thread) => thread.id));
  };

  const pin = threads.some((thread) => !pins.includes(thread.id))
    ? () => {
        let next = pins;
        return void run("pin", (thread) => {
          next = togglePin(next, thread.id);
          setPins(next);
          return true;
        });
      }
    : undefined;
  const unpin = threads.some((thread) => pins.includes(thread.id))
    ? () => {
        const gone = new Set<string>();
        return void run("unpin", (thread) => {
          gone.add(thread.id);
          setPins(pins.filter((id) => !gone.has(id)));
          return true;
        });
      }
    : undefined;

  const buttons = [
    box === "archive" && onRestore
      ? {
          icon: ArchiveRestore,
          label: "Back to Inbox",
          run: () => void run("restore", (thread) => onRestore(thread.id)),
        }
      : box === "archive"
        ? undefined
        : {
            icon: Archive,
            label: "Archive",
            run: () => void run("archive", (thread) => onArchive(thread.id)),
          },
    ...(box === "inbox" && onLater
      ? [
          {
            icon: Clock,
            label: "Later",
            run: () => {
              const until = laterTime(Date.now());
              return void run("later", (thread) => onLater(thread.id, until));
            },
          },
        ]
      : []),
    ...(pin ? [{ icon: Pin, label: "Pin", run: pin }] : []),
    ...(unpin ? [{ icon: PinOff, label: "Unpin", run: unpin }] : []),
    ...(threads.some((thread) => thread.unread)
      ? [
          {
            icon: MailOpen,
            label: "Mark read",
            run: () =>
              void run("read", (thread) => {
                onMarkRead([thread]);
                return true;
              }),
          },
        ]
      : []),
  ].flatMap((button) => (button === undefined ? [] : [button]));

  return (
    <div className="mx-2 mb-2 flex flex-col gap-0.5 rounded-lg border border-line-subtle bg-surface-raised px-1.5 py-1">
      <div className="flex items-center gap-1">
        <output className="min-w-0 flex-1 truncate px-1 text-meta font-medium text-fg-secondary">
          {threads.length === 1 ? "1 selected" : `${threads.length} selected`}
        </output>
        <button
          type="button"
          onClick={() => onSettled(ids)}
          aria-label="Clear selection"
          title="Clear selection (Esc)"
          className="grid size-6 shrink-0 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-primary"
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-px" role="toolbar" aria-label="Bulk actions">
        {buttons.map((button) => (
          <button
            key={button.label}
            type="button"
            onClick={button.run}
            className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-meta font-medium text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary max-md:h-8"
          >
            <button.icon size={13} strokeWidth={1.75} />
            {button.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            if (planBulk(byId, ids, "delete").act.length === 0) {
              onNote(summarizeBulk("delete", planBulk(byId, ids, "delete")));
            } else {
              setConfirming(true);
            }
          }}
          className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-meta font-medium text-fg-secondary transition-colors hover:bg-surface-hover hover:text-error max-md:h-8"
        >
          <Trash2 size={13} strokeWidth={1.75} />
          Delete
        </button>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${threads.length === 1 ? "this thread" : `these ${threads.length} threads`}?`}
        description="Every message in them will be deleted for good. This can't be undone."
        confirmLabel="Delete"
        onConfirm={() => void run("delete", (thread) => onDelete(thread.id))}
      />
    </div>
  );
}
