import { Button } from "@base-ui/react/button";
import { Monitor } from "lucide-react";
import { useState, type ReactNode } from "react";

import { shortAgo } from "../../lib/time.ts";
import { paneDrag, THREAD_DRAG_TYPE } from "../split/drag.ts";
import { DeleteThreadDialog } from "./Delete.tsx";
import type { ThreadSummary } from "./model.ts";
import { TitleField, useRename, type RenameThread } from "./Rename.tsx";
import { moreRoom, RowFrame, yieldsToMore } from "./RowFrame.tsx";
import { ProviderStack, ThreadMark } from "./StatusIndicator.tsx";

/**
 * What leads a row: the thread's mark (project, harness and status) at the size of a project badge,
 * which tells projects apart when the list holds several; a smaller one when it doesn't; or nothing.
 */
export type RowMark = "badge" | "dot" | "none";

/** What a row's menu can do to its thread itself, beside whatever the caller adds. */
export interface RowControls {
  readonly rename: () => void;
  readonly remove: () => void;
}

export interface ThreadRowProps {
  readonly thread: ThreadSummary;
  readonly selected: boolean;
  readonly mark: RowMark;
  /** Whether to show which harness runs it: only worth a logo on every row when they differ. */
  readonly harness: boolean;
  /** An archived thread's row is dimmer. */
  readonly quiet?: boolean;
  /** Opens the thread; `newTab` keeps it in a tab of its own rather than the preview. */
  readonly onSelect: (threadId: string, newTab?: boolean) => void;
  readonly onRename: RenameThread;
  /** The menu's items, built from what the row lets them do; none when the thread has no actions here. */
  readonly menu?: (controls: RowControls) => ReactNode;
  /** Deleting is confirmed first; this runs once it is. */
  readonly onDelete?: (threadId: string) => void;
}

/** One thread in the inbox, the chat list or the archive: a line, with its actions a click away. */
export function ThreadRow({
  thread,
  selected,
  mark,
  harness,
  quiet = false,
  onSelect,
  onRename,
  menu,
  onDelete,
}: ThreadRowProps) {
  const [deleting, setDeleting] = useState(false);
  const { editing, start, finish, title, row } = useRename(thread, onRename);
  const unread = thread.unread && !selected;
  const rowClass = `flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-body transition-colors duration-150 data-popup-open:bg-surface-hover max-md:h-11 max-md:gap-3 max-md:rounded-lg max-md:text-[15px] ${menu === undefined ? "" : moreRoom} ${
    selected || editing
      ? "bg-surface-selected text-fg-primary"
      : quiet
        ? "text-fg-tertiary hover:bg-surface-hover hover:text-fg-primary"
        : "text-fg-secondary hover:bg-surface-hover hover:text-fg-primary"
  }`;
  const titleClass = `min-w-0 flex-1 truncate ${unread ? "font-medium text-fg-primary" : ""}`;
  const offline = thread.elsewhere?.online === false;
  const content = (
    <>
      {mark === "none" ? null : (
        <ThreadMark thread={thread} unread={unread} size={mark === "badge" ? "medium" : "small"} />
      )}
      {editing ? (
        <TitleField title={thread.title} onDone={finish} className={`-mx-1 h-6 ${titleClass}`} />
      ) : (
        <span className={titleClass}>
          {mark === "badge" && thread.project ? <span className="sr-only">{thread.project}: </span> : null}
          {title}
        </span>
      )}
      {new Set(thread.providers).size > 1 || (harness && mark === "none") ? (
        <ProviderStack providers={thread.providers} />
      ) : null}
      {thread.machine ? (
        <span
          title={offline ? `On ${thread.machine}, which is offline` : `On ${thread.machine}`}
          className={`shrink-0 text-fg-tertiary ${offline ? "opacity-60" : ""}`}
        >
          <Monitor size={11} strokeWidth={2} aria-label={`On ${thread.machine}`} />
        </span>
      ) : null}
      <span className={`w-6 shrink-0 text-right text-caption text-fg-tertiary tabular-nums ${yieldsToMore}`}>
        {shortAgo(thread.updatedAt)}
      </span>
    </>
  );

  // While renaming, the row is a field rather than a button, and right-clicks get the text menu.
  if (editing) return <div className={rowClass}>{content}</div>;
  const button = (
    <Button
      ref={row}
      // Ctrl or the middle button opens it in a tab of its own.
      onClick={(event) => onSelect(thread.id, event.ctrlKey || event.metaKey)}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button === 1) onSelect(thread.id, true);
      }}
      data-thread={thread.id}
      aria-current={selected ? "page" : undefined}
      // Dragged onto the conversation, it opens beside it, or in its place; an archived one stays put.
      draggable={!quiet}
      onDragStart={(event) => {
        event.dataTransfer.setData(THREAD_DRAG_TYPE, thread.id);
        event.dataTransfer.effectAllowed = "move";
        paneDrag.begin({ kind: "thread", key: thread.id }, event.clientX, event.clientY);
      }}
      onDragEnd={() => paneDrag.cancel()}
      // The full title, and where it is, for a row too narrow to say.
      title={mark === "badge" && thread.project ? `${title}\n${thread.project}` : title}
      className={rowClass}
    >
      {content}
    </Button>
  );
  if (menu === undefined) return button;
  return (
    <>
      <RowFrame label={title} menu={menu({ rename: start, remove: () => setDeleting(true) })}>
        {button}
      </RowFrame>
      {onDelete ? (
        <DeleteThreadDialog
          thread={thread}
          open={deleting}
          onOpenChange={setDeleting}
          onConfirm={() => onDelete(thread.id)}
        />
      ) : null}
    </>
  );
}
