import { Button } from "@base-ui/react/button";
import { ChevronDown, Ellipsis, Monitor, Pin, type LucideIcon } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";

import { ContextMenuArea, MenuPopup, MenuRoot, MenuTrigger } from "../../components/ui/Menu.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { shortAgo } from "../../lib/time.ts";
import { paneDrag, THREAD_DRAG_TYPE } from "../split/drag.ts";
import { SelectBox, type SelectMode } from "./BulkBar.tsx";
import { DeleteThreadDialog } from "./Delete.tsx";
import { needsYou, type ThreadSummary } from "./model.ts";
import { TitleField, useRename, type RenameThread } from "./Rename.tsx";
import { ProviderStack, ThreadMark } from "./StatusIndicator.tsx";
import type { RowControls } from "./ThreadRow.tsx";

/** A one-click action on a card, shown on hover in place of its time; `key` runs it from the keyboard. */
export interface CardAction {
  readonly icon: LucideIcon;
  readonly label: string;
  /** A letter that runs it while the card has focus. */
  readonly key?: string;
  readonly run: () => void;
}

export interface InboxCardProps {
  readonly thread: ThreadSummary;
  readonly selected: boolean;
  readonly pinned: boolean;
  /** What the right end says while the card rests: by default how long ago it last changed. */
  readonly when?: string;
  readonly actions: ReadonlyArray<CardAction>;
  /** Opens the thread; `newTab` keeps it in a tab of its own rather than the preview. */
  readonly onSelect: (threadId: string, newTab?: boolean) => void;
  readonly onRename: RenameThread;
  /** The menu's items; none when the thread has no actions here. */
  readonly menu?: (controls: RowControls) => ReactNode;
  readonly onDelete?: (threadId: string) => void;
  /**
   * Bulk picking: whether the card is picked (`mixed` for a run with some threads picked), and
   * how a click picks it. Ctrl or ⌘ ticks instead of opening; Shift ticks a run of the list.
   */
  readonly selection?: {
    readonly checked: boolean;
    readonly mixed: boolean;
    readonly onToggle: (mode: SelectMode) => void;
  };
  /**
   * Makes it a multi-agent run's card, `thread` summing up its threads: a click folds out the
   * comparison of them below it rather than opening one, and the meta line ends in `tally`.
   */
  readonly group?: {
    readonly count: number;
    readonly open: boolean;
    readonly onToggle: () => void;
    readonly tally: ReactNode;
  };
}

const asks = { awaitingApproval: "Needs you", failed: "Failed" } as const;

/**
 * A thread in the inbox, Later or Archive: its title over where it is, with its status on its
 * project's badge. Hovering shows its quick actions in place of its time, beside the menu.
 */
export function InboxCard({
  thread,
  selected,
  pinned,
  when,
  actions,
  onSelect,
  onRename,
  menu,
  onDelete,
  group,
  selection,
}: InboxCardProps) {
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const { editing, start, finish, title, row } = useRename(thread, onRename);
  const unread = thread.unread && !selected;
  const status =
    needsYou(thread) && (thread.status === "awaitingApproval" || thread.status === "failed")
      ? thread.status
      : undefined;
  const offline = thread.elsewhere?.online === false;
  const menuItems = menu?.({ rename: start, remove: () => setDeleting(true) });
  // The card fades out as an action takes it to another list, and back if the action fails.
  const run = (action: CardAction) => {
    setLeaving(true);
    action.run();
    setTimeout(() => setLeaving(false), 1500);
  };
  // Room the quick actions and the menu button take at the right end on hover.
  const room = (actions.length + (menuItems === undefined ? 0 : 1)) * 24;

  const cardClass = `grid w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0.5 rounded-lg px-2 pt-2 pb-2.25 text-left text-body transition-[background-color,opacity] duration-150 data-popup-open:bg-surface-hover max-md:gap-x-3 max-md:rounded-xl max-md:px-2.5 max-md:py-2.5 max-md:text-[15px] ${selection === undefined ? "" : "pointer-coarse:pl-7"} ${
    leaving ? "opacity-0" : ""
  } ${selected || editing ? "bg-surface-selected" : "hover:bg-surface-hover"}`;
  const titleClass = `min-w-0 truncate ${
    unread || selected ? "font-medium text-fg-primary" : "text-fg-secondary"
  }`;

  const content = (
    <>
      <span className="row-span-2 self-start pt-px max-md:pt-0.5">
        <ThreadMark thread={thread} unread={unread} {...(group ? { count: group.count } : {})} />
      </span>
      {editing ? (
        <TitleField title={thread.title} onDone={finish} className={`-mx-1 h-5.5 ${titleClass}`} />
      ) : (
        <span className={titleClass}>{title}</span>
      )}
      <span
        style={{ "--room": `${room}px` } as CSSProperties}
        className={`flex min-w-7 justify-end text-meta whitespace-nowrap text-fg-tertiary tabular-nums transition-[min-width] duration-150 md:group-hover/row:min-w-(--room) md:group-has-[:focus-visible]/row:min-w-(--room) md:group-has-[[data-popup-open]]/row:min-w-(--room) max-md:text-[13px] ${
          menuItems === undefined ? "" : "max-md:min-w-9 pointer-coarse:min-w-9"
        }`}
      >
        <span className="transition-opacity duration-150 md:group-hover/row:opacity-0 md:group-has-[:focus-visible]/row:opacity-0 md:group-has-[[data-popup-open]]/row:opacity-0 pointer-coarse:hidden">
          {when ?? shortAgo(thread.updatedAt)}
        </span>
      </span>
      <span className="col-start-2 col-end-4 flex min-w-0 items-center gap-1.5 text-meta text-fg-tertiary max-md:text-[13px]">
        <span className="min-w-0 flex-1 truncate">
          {status ? (
            <>
              <span className={`font-medium ${status === "failed" ? "text-error" : "text-attention"}`}>
                {asks[status]}
              </span>
              {thread.project ? " · " : ""}
            </>
          ) : null}
          {thread.project}
          {thread.worktree ? (
            <>
              {" · "}
              <span className="font-mono text-caption max-md:text-xs">{thread.worktree.branch}</span>
            </>
          ) : null}
          {group ? <> · {group.tally}</> : null}
        </span>
        {pinned ? <Pin size={11} strokeWidth={2} aria-label="Pinned" className="shrink-0" /> : null}
        {thread.machine ? (
          <span
            title={offline ? `On ${thread.machine}, which is offline` : `On ${thread.machine}`}
            className={`shrink-0 ${offline ? "opacity-60" : ""}`}
          >
            <Monitor size={11} strokeWidth={2} aria-label={`On ${thread.machine}`} />
          </span>
        ) : null}
        {/* The lead's harness is on the mark; the rest only when they differ from it. */}
        {group ? (
          <ChevronDown
            size={13}
            strokeWidth={1.75}
            aria-hidden
            className={`shrink-0 transition-transform duration-150 ${group.open ? "rotate-180" : ""}`}
          />
        ) : new Set(thread.providers).size > 1 ? (
          <ProviderStack providers={thread.providers} />
        ) : null}
      </span>
    </>
  );

  if (editing) return <div className={cardClass}>{content}</div>;
  const button = (
    <Button
      ref={row}
      // With bulk picking, Ctrl or ⌘ ticks the card and Shift ticks a run of the list; else
      // Ctrl or the middle button opens it in a tab of its own.
      onClick={(event) => {
        if (selection !== undefined && event.shiftKey) selection.onToggle("range");
        else if (selection !== undefined && (event.ctrlKey || event.metaKey)) selection.onToggle("toggle");
        else if (group) group.onToggle();
        else onSelect(thread.id, selection === undefined && (event.ctrlKey || event.metaKey));
      }}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button === 1 && group === undefined) onSelect(thread.id, true);
      }}
      onKeyDown={(event) => {
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        const action = actions.find((candidate) => candidate.key === event.key.toLowerCase());
        if (action === undefined) return;
        event.preventDefault();
        run(action);
      }}
      data-thread={thread.id}
      aria-current={selected ? "page" : undefined}
      aria-expanded={group?.open}
      aria-label={[status ? asks[status] : undefined, title, thread.project].filter(Boolean).join(", ")}
      // Dragged onto the conversation, it opens beside it, or in its place.
      draggable={group === undefined}
      onDragStart={(event) => {
        event.dataTransfer.setData(THREAD_DRAG_TYPE, thread.id);
        event.dataTransfer.effectAllowed = "move";
        paneDrag.begin({ kind: "thread", key: thread.id }, event.clientX, event.clientY);
      }}
      onDragEnd={() => paneDrag.cancel()}
      title={thread.project ? `${title}\n${thread.project}` : title}
      className={cardClass}
    >
      {content}
    </Button>
  );

  return (
    <>
      <div className="group/row relative">
        {menuItems === undefined ? button : <ContextMenuArea menu={menuItems}>{button}</ContextMenuArea>}
        {selection === undefined ? null : (
          <SelectBox
            checked={selection.checked}
            mixed={selection.mixed}
            label={group ? `Select these ${group.count} threads` : `Select “${title}”`}
            onChange={() => selection.onToggle("toggle")}
            className="left-2 top-2"
          />
        )}
        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-has-[[data-popup-open]]/row:opacity-100 focus-within:opacity-100 md:group-hover/row:opacity-100 max-md:top-2 pointer-coarse:opacity-100">
          {actions.map((action) => (
            <Tooltip
              key={action.label}
              label={action.label}
              {...(action.key ? { shortcut: action.key.toUpperCase() } : {})}
            >
              <Button
                aria-label={`${action.label}: “${title}”`}
                onClick={() => run(action)}
                className="grid size-5.5 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-active hover:text-fg-primary pointer-coarse:hidden"
              >
                <action.icon size={13} strokeWidth={1.75} />
              </Button>
            </Tooltip>
          ))}
          {menuItems === undefined ? null : (
            <MenuRoot>
              <MenuTrigger>
                <Button
                  aria-label={`More actions for “${title}”`}
                  className="grid size-5.5 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-active hover:text-fg-primary data-popup-open:bg-surface-active data-popup-open:text-fg-primary max-md:size-8"
                >
                  <Ellipsis size={14} strokeWidth={1.75} />
                </Button>
              </MenuTrigger>
              <MenuPopup>{menuItems}</MenuPopup>
            </MenuRoot>
          )}
        </div>
      </div>
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
