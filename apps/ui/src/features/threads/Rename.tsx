import { MAX_THREAD_TITLE } from "@cerium/protocol";
import { useEffect, useRef, useState } from "react";

import { renamedTitle, type ThreadSummary } from "./model.ts";

/** Saves a thread's new title; resolves whether the backend took it. */
export type RenameThread = (threadId: string, title: string) => Promise<boolean>;

/**
 * A row's inline rename: whether its title is a text field, and the title to show. A saved title
 * shows straight away and until the thread list carries it, so the old one doesn't flash back.
 * `row` goes on the row's button, which gets focus back when Enter or Esc ends the rename.
 */
export function useRename(thread: ThreadSummary, onRename: RenameThread) {
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<string>();
  if (saved !== undefined && thread.title === saved) setSaved(undefined);
  const row = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    row.current?.focus();
  }, [editing]);

  const finish = (typed: string | undefined, byKey: boolean) => {
    refocus.current = byKey;
    setEditing(false);
    const title = typed === undefined ? undefined : renamedTitle(thread.title, typed);
    if (title === undefined) return;
    setSaved(title);
    void onRename(thread.id, title).then((renamed) => {
      if (!renamed) setSaved(undefined);
    });
  };

  return { editing, start: () => setEditing(true), finish, title: saved ?? thread.title, row };
}

/**
 * A thread's title as a text field, selected and ready to type over. Enter or leaving the field
 * saves; Esc cancels.
 */
export function TitleField({
  title,
  onDone,
  className,
  maxLength = MAX_THREAD_TITLE,
  label = "Title",
}: {
  title: string;
  /** The typed title, or undefined when cancelled; `byKey` when Enter or Esc ended it. */
  onDone: (typed: string | undefined, byKey: boolean) => void;
  className: string;
  /** For names other than a thread's, such as a device's. */
  maxLength?: number;
  label?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  /** Enter, Esc and leaving the field can all end the edit; only the first counts. */
  const done = useRef(false);
  const finish = (typed: string | undefined, byKey = true) => {
    if (done.current) return;
    done.current = true;
    onDone(typed, byKey);
  };
  // Selected backwards, so a long title shows its start rather than its end.
  useEffect(() => {
    const field = input.current;
    field?.focus();
    field?.setSelectionRange(0, field.value.length, "backward");
    if (field) field.scrollLeft = 0;
  }, []);

  return (
    <input
      ref={input}
      defaultValue={title}
      maxLength={maxLength}
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(event.currentTarget.value);
        } else if (event.key === "Escape") {
          // Esc only cancels the rename, not whatever else listens for it.
          event.preventDefault();
          event.stopPropagation();
          finish(undefined);
        }
      }}
      onBlur={(event) => finish(event.currentTarget.value, false)}
      className={`min-w-0 rounded-sm bg-surface-window px-1 text-fg-primary ring-1 ring-line-strong outline-none ${className}`}
    />
  );
}
