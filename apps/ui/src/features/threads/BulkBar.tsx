import { Checkbox } from "@base-ui/react/checkbox";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Archive, ArchiveRestore, Check, Clock, MailOpen, Minus, Pin, PinOff, Trash2, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { ConfirmDialog } from "../../components/ui/ConfirmDialog.tsx";
import { pinnedAtom, togglePin } from "./pins.ts";
import { planBulk, rangeSelected, summarizeBulk, toggleSelected, type BulkAction } from "./bulk.ts";
import type { InboxBox, ThreadSummary } from "./model.ts";

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
 * action. Delete asks first. Whatever is skipped is named in the note.
 */
export function BulkBar({
  box,
  threads,
  onArchive,
  onRestore,
  onLater,
  onMarkRead,
  onDelete,
  onClear,
  onNote,
}: {
  /** Which list the picked threads are in; the chat list takes no Later or Back to Inbox. */
  readonly box: InboxBox | "chat";
  /** The picked threads of this list, in its order. */
  readonly threads: ReadonlyArray<ThreadSummary>;
  readonly onArchive: (threadId: string) => void;
  /** Brings threads back; shown only in Archive. */
  readonly onRestore: ((threadId: string) => void) | undefined;
  /** Puts threads off; absent where the machine can't. */
  readonly onLater: ((ids: ReadonlyArray<string>) => void) | undefined;
  readonly onMarkRead: (threads: ReadonlyArray<ThreadSummary>) => void;
  readonly onDelete: (threadId: string) => void;
  readonly onClear: () => void;
  readonly onNote: (note: string) => void;
}) {
  const pins = useAtomValue(pinnedAtom);
  const setPins = useAtomSet(pinnedAtom);
  const [confirming, setConfirming] = useState(false);
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const ids = threads.map((thread) => thread.id);

  /** Runs `action` thread by thread, names what was skipped, and drops moved threads. */
  const run = (action: BulkAction, apply: (taken: ReadonlyArray<ThreadSummary>) => void) => {
    const plan = planBulk(byId, ids, action);
    apply(plan.act);
    onNote(summarizeBulk(action, plan));
    if (action === "archive" || action === "later" || action === "restore" || action === "delete") {
      onClear();
    }
  };

  const pin = threads.some((thread) => !pins.includes(thread.id))
    ? () =>
        run("pin", (taken) => {
          let next = pins;
          for (const thread of taken) next = togglePin(next, thread.id);
          setPins(next);
        })
    : undefined;
  const unpin = threads.some((thread) => pins.includes(thread.id))
    ? () =>
        run("unpin", (taken) => {
          const gone = new Set(taken.map((thread) => thread.id));
          setPins(pins.filter((id) => !gone.has(id)));
        })
    : undefined;

  const buttons = [
    box === "archive" && onRestore
      ? {
          icon: ArchiveRestore,
          label: "Back to Inbox",
          run: () => run("restore", (taken) => taken.forEach((thread) => onRestore(thread.id))),
        }
      : box === "archive"
        ? undefined
        : {
            icon: Archive,
            label: "Archive",
            run: () => run("archive", (taken) => taken.forEach((thread) => onArchive(thread.id))),
          },
    ...(box === "inbox" && onLater
      ? [
          {
            icon: Clock,
            label: "Later",
            run: () => run("later", (taken) => onLater(taken.map((thread) => thread.id))),
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
            run: () => run("read", (taken) => onMarkRead(taken)),
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
          onClick={onClear}
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
        onConfirm={() => run("delete", (taken) => taken.forEach((thread) => onDelete(thread.id)))}
      />
    </div>
  );
}
