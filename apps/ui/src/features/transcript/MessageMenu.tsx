import { ClipboardCopy, Copy, ExternalLink, Link, TextQuote } from "lucide-react";
import { useState, type MouseEvent, type ReactNode } from "react";

import { ContextMenuArea, MenuItem, MenuSeparator } from "../../components/ui/Menu.tsx";
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
  const element = target?.querySelector<HTMLElement>("[data-streamdown='link']");
  return {
    selection: selectionWithin(event.currentTarget),
    ...(href && element && event.currentTarget.contains(target) ? { link: { href, element } } : {}),
  };
};

/**
 * A message in the transcript, with its right-click menu: the link under the pointer, the selected
 * text, the whole message, and (for the user's own) putting it back into the message box. Chips and
 * images inside keep their own menus.
 */
export function MessageMenuArea({
  text,
  onCopyToMessageBox,
  className,
  children,
}: {
  /** What "Copy message" copies; nothing to copy leaves the item out. */
  text: string;
  onCopyToMessageBox?: (() => void) | undefined;
  className?: string;
  children: ReactNode;
}) {
  const [hit, setHit] = useState<Hit>({ selection: "" });
  const { link, selection } = hit;
  const hasMain = selection !== "" || text !== "" || onCopyToMessageBox !== undefined;
  // Links and selections live in the text, so without any there is nothing to offer.
  if (text === "" && onCopyToMessageBox === undefined) return <div className={className}>{children}</div>;
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
        </>
      }
    >
      <div className={className} onContextMenu={(event) => setHit(hitAt(event))}>
        {children}
      </div>
    </ContextMenuArea>
  );
}
