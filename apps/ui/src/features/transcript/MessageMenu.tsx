import { Button } from "@base-ui/react/button";
import {
  BookmarkPlus,
  Briefcase,
  ClipboardCopy,
  Copy,
  ExternalLink,
  GitFork,
  Link,
  ListTodo,
  Pencil,
  RotateCcw,
  TextQuote,
} from "lucide-react";
import { useState, type MouseEvent, type ReactNode } from "react";

import { ContextMenuArea, MenuItem, MenuSeparator } from "../../components/ui/Menu.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { copyText, isOpenableLink, LINK_ATTRIBUTE } from "./menus.ts";

/** What a right-click inside a message found, captured as the menu opens. */
interface Hit {
  /** The part of the selection inside the message. */
  readonly selection: string;
  readonly link?: { readonly href: string; readonly element: HTMLElement };
}

/** The selected text that lies inside `element`; empty when none does. */
const selectionWithin = (element: HTMLElement): string => {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  const range = selection.getRangeAt(0).cloneRange();
  if (!range.intersectsNode(element)) return "";
  if (!element.contains(range.startContainer)) range.setStart(element, 0);
  if (!element.contains(range.endContainer)) range.setEnd(element, element.childNodes.length);
  return range.toString();
};

const hitAt = (event: MouseEvent<HTMLElement>): Hit => {
  const target = event.target instanceof Element ? event.target.closest(`[${LINK_ATTRIBUTE}]`) : null;
  const href = target?.getAttribute(LINK_ATTRIBUTE);
  const element = target instanceof HTMLElement ? target : undefined;
  return {
    selection: selectionWithin(event.currentTarget),
    ...(href && element && event.currentTarget.contains(target) ? { link: { href, element } } : {}),
  };
};

/**
 * A message in the transcript, with its right-click menu: the link under the pointer, the selected
 * text, the whole message, and (for the user's own) putting it back into the message box, editing
 * it or restoring the thread to before it. Chips and images inside keep their own menus.
 */
export function MessageMenuArea({
  text,
  onCopyToMessageBox,
  onSavePrompt,
  onEdit,
  onRestore,
  onFork,
  onImplementInWork,
  onAddTask,
  actionsOnHover = false,
  className,
  children,
}: {
  /** What "Copy message" copies; nothing to copy leaves the item out. */
  text: string;
  onCopyToMessageBox?: (() => void) | undefined;
  /** Keeps the user's own message as a saved prompt. */
  onSavePrompt?: (() => void) | undefined;
  /** Opens the user's own message for editing, to send it again. */
  onEdit?: (() => void) | undefined;
  /** Asks to restore the thread to before the user's own message. */
  onRestore?: (() => void) | undefined;
  /** Asks to fork the thread into a new one from the user's own message. */
  onFork?: (() => void) | undefined;
  /** Moves this chat into a work thread and opens the implementation wizard for this message. */
  onImplementInWork?: (() => void) | undefined;
  onAddTask?: ((text: string) => void) | undefined;
  /** Keeps the corner action out of sight until the message is pointed at or reached by keyboard, where messages stack. */
  actionsOnHover?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [hit, setHit] = useState<Hit>({ selection: "" });
  const { link, selection } = hit;
  const ownActions =
    onCopyToMessageBox !== undefined ||
    onEdit !== undefined ||
    onRestore !== undefined ||
    onFork !== undefined ||
    onImplementInWork !== undefined;
  const hasMain = selection !== "" || text !== "" || ownActions;
  // Links and selections live in the text, so without any there is nothing to offer.
  if (text === "" && !ownActions) {
    return <div className={className}>{children}</div>;
  }
  return (
    <ContextMenuArea
      menu={
        <>
          {link && isOpenableLink(link.href) ? (
            // The link's own click, so opening it from here behaves just the same.
            <MenuItem icon={ExternalLink} onClick={() => link.element.click()}>
              Open link
            </MenuItem>
          ) : null}
          {link ? (
            <MenuItem icon={Link} onClick={() => copyText(link.href)}>
              Copy link address
            </MenuItem>
          ) : null}
          {link && hasMain ? <MenuSeparator /> : null}
          {selection === "" ? null : (
            <MenuItem icon={Copy} shortcut="Ctrl C" onClick={() => copyText(selection)}>
              Copy
            </MenuItem>
          )}
          {text === "" ? null : (
            <MenuItem icon={ClipboardCopy} onClick={() => copyText(text)}>
              Copy message
            </MenuItem>
          )}
          {onCopyToMessageBox ? (
            <MenuItem icon={TextQuote} onClick={onCopyToMessageBox}>
              Copy to message box
            </MenuItem>
          ) : null}
          {onSavePrompt ? (
            <MenuItem icon={BookmarkPlus} onClick={onSavePrompt}>
              Save as prompt
            </MenuItem>
          ) : null}
          {onEdit ? (
            <MenuItem icon={Pencil} onClick={onEdit}>
              Edit message
            </MenuItem>
          ) : null}
          {onRestore ? (
            <MenuItem icon={RotateCcw} onClick={onRestore}>
              Restore to before this message
            </MenuItem>
          ) : null}
          {onFork ? (
            <MenuItem icon={GitFork} onClick={onFork}>
              Fork into new thread
            </MenuItem>
          ) : null}
          {onImplementInWork ? (
            <MenuItem icon={Briefcase} onClick={onImplementInWork}>
              Implement in work…
            </MenuItem>
          ) : null}
          {onAddTask === undefined || text.trim() === "" ? null : (
            <MenuItem icon={ListTodo} onClick={() => onAddTask(text)}>
              Add to Tasks
            </MenuItem>
          )}
        </>
      }
    >
      <div
        className={`group/message relative ${className ?? ""}`}
        onContextMenu={(event) => setHit(hitAt(event))}
      >
        {children}
        {/* The menu's Add to Tasks within reach of a pointer and the keyboard, in the message's corner. */}
        {onAddTask === undefined || text.trim() === "" ? null : (
          <Tooltip label="Add to Tasks" side="top">
            <Button
              aria-label="Add to Tasks"
              onClick={() => onAddTask(text)}
              className={`absolute -top-1 right-0 z-10 grid size-6 place-items-center rounded-md border border-line-subtle bg-surface-overlay text-fg-tertiary shadow-overlay backdrop-blur-xl transition-[opacity,color] duration-150 ease-out-soft outline-none select-none hover:text-fg-primary focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-focus-ring pointer-coarse:size-8 ${
                actionsOnHover
                  ? "pointer-fine:pointer-events-none pointer-fine:opacity-0 pointer-fine:group-hover/message:pointer-events-auto pointer-fine:group-hover/message:opacity-100 pointer-fine:focus-visible:opacity-100"
                  : ""
              }`}
            >
              <ListTodo size={13} strokeWidth={1.75} />
            </Button>
          </Tooltip>
        )}
      </div>
    </ContextMenuArea>
  );
}
