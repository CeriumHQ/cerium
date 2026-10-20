import {
  ClipboardPaste,
  Copy,
  ExternalLink,
  Link,
  Scissors,
  TextSelect,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useEffect, useState } from "react";

import { shellBridge, type TextCommand, type TextMenuRequest } from "../backend/shell.ts";
import { MenuItem, MenuSeparator, PointMenu } from "../components/ui/Menu.tsx";
import { textMenuGroups } from "./textMenuGroups.ts";

const icons: Partial<Record<TextCommand["kind"], LucideIcon>> = {
  cut: Scissors,
  copy: Copy,
  paste: ClipboardPaste,
  selectAll: TextSelect,
  copySelection: Copy,
  openLink: ExternalLink,
  copyLink: Link,
};

const shortcuts: Partial<Record<TextCommand["kind"], string>> = {
  cut: "Ctrl X",
  copy: "Ctrl C",
  paste: "Ctrl V",
  selectAll: "Ctrl A",
};

/** The field right-clicked and where its caret or selection was, to put back before a command. */
type Caret =
  | {
      readonly kind: "input";
      readonly element: HTMLInputElement | HTMLTextAreaElement;
      readonly start: number | null;
      readonly end: number | null;
    }
  | { readonly kind: "editable"; readonly element: HTMLElement; readonly range: Range | undefined };

const caretOf = (): Caret | undefined => {
  const element = document.activeElement;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return { kind: "input", element, start: element.selectionStart, end: element.selectionEnd };
  }
  if (!(element instanceof HTMLElement) || !element.isContentEditable) return undefined;
  const selection = document.getSelection();
  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : undefined;
  return {
    kind: "editable",
    element,
    range: range && element.contains(range.commonAncestorContainer) ? range : undefined,
  };
};

const select = (range: Range) => {
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
};

/** Focuses the field again with its caret or selection as it was, so a command lands there. */
const restore = (caret: Caret) => {
  if (caret.kind === "input") {
    caret.element.focus({ preventScroll: true });
    if (caret.start !== null && caret.end !== null) caret.element.setSelectionRange(caret.start, caret.end);
    return;
  }
  // The selection goes back first: a field that gains focus without one may move its caret.
  if (caret.range) select(caret.range);
  caret.element.focus({ preventScroll: true });
  if (caret.range) select(caret.range);
};

/**
 * The app-wide menu for text and links: Cut, Copy, Paste, Selection and link items wherever no
 * page menu claimed the right-click. The shell reports the right-click and runs the commands;
 * in the browser preview the browser's own menu shows instead.
 */
export function TextMenu() {
  const [request, setRequest] = useState<TextMenuRequest>();
  const [caret, setCaret] = useState<Caret>();
  const [open, setOpen] = useState(false);

  useEffect(
    () =>
      shellBridge()?.onTextMenu?.((next) => {
        if (textMenuGroups(next).length === 0) {
          setOpen(false);
          return;
        }
        setRequest(next);
        setCaret(next.editable ? caretOf() : undefined);
        setOpen(true);
      }),
    [],
  );

  // Another right-click, wherever it goes, or leaving the window closes it; the shell reopens it
  // at a right-click no page menu takes.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("contextmenu", close, true);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("contextmenu", close, true);
      window.removeEventListener("blur", close);
    };
  }, [open]);

  if (request === undefined) return null;

  // After the click: the menu focuses the item it was clicked on once its handler has run.
  const run = (command: TextCommand) =>
    setTimeout(() => {
      if (caret) restore(caret);
      void shellBridge()?.runTextCommand?.(command);
    });

  return (
    <PointMenu
      point={request}
      open={open}
      onOpenChange={(next, details) => {
        setOpen(next);
        // Esc returns to the field, like a native menu; a click elsewhere goes where it went.
        if (!next && details.reason === "escape-key" && caret) restore(caret);
      }}
    >
      {textMenuGroups(request).map((group, index) => (
        <Fragment key={group[0]?.label ?? index}>
          {index > 0 ? <MenuSeparator /> : null}
          {group.map((entry) => (
            <MenuItem
              key={entry.label}
              {...(icons[entry.command.kind] ? { icon: icons[entry.command.kind] } : {})}
              {...(shortcuts[entry.command.kind] ? { shortcut: shortcuts[entry.command.kind] } : {})}
              {...(entry.disabled ? { disabled: true } : {})}
              onClick={() => run(entry.command)}
            >
              {entry.label}
            </MenuItem>
          ))}
        </Fragment>
      ))}
    </PointMenu>
  );
}
