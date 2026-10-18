import { useSyncExternalStore } from "react";

import { useCompact } from "../app/compact.ts";

// The phone's keyboard (docs/architecture.md §14.10). iOS shrinks the visible part of the page for
// it without resizing the page, and scrolls the page to show the focused field, which would leave the
// message box under the keyboard or the top bar off the screen. So the window follows the visible
// part instead: app.css sizes and places #root by these properties.

export const followVisualViewport = () => {
  const visible = window.visualViewport;
  if (visible === null) return;
  const root = document.documentElement.style;
  const update = () => {
    root.setProperty("--app-height", `${visible.height}px`);
    root.setProperty("--app-top", `${visible.offsetTop}px`);
  };
  visible.addEventListener("resize", update);
  visible.addEventListener("scroll", update);
  update();
};

/** How much shorter than its tallest the visible part gets before that is a keyboard, not a toolbar. */
const KEYBOARD = 150;

let keyboardOpen = false;
const listeners = new Set<() => void>();

const isEditable = (element: Element | null) =>
  element instanceof HTMLElement &&
  (element.isContentEditable || element.tagName === "INPUT" || element.tagName === "TEXTAREA");

/**
 * Tracks whether the keyboard is up: while a field has focus and the visible part is well short of
 * the tallest it has been at this width. iOS shrinks only the visible part, Android the whole page.
 * Focus alone isn't enough, since iOS gives a field focus without a keyboard when the page asks.
 */
export const followKeyboard = () => {
  const visible = window.visualViewport;
  if (visible === null) return;
  let width = 0;
  let tallest = 0;
  const measure = () => {
    const height = visible.height * visible.scale;
    if (visible.width * visible.scale !== width) {
      width = visible.width * visible.scale;
      tallest = 0;
    }
    tallest = Math.max(tallest, height);
    const open = isEditable(document.activeElement) && tallest - height > KEYBOARD;
    if (open !== keyboardOpen) {
      keyboardOpen = open;
      for (const listener of listeners) listener();
    }
  };
  visible.addEventListener("resize", measure);
  document.addEventListener("focusin", measure);
  // After focus lands, so moving from one field to another doesn't close it in between.
  document.addEventListener("focusout", () => setTimeout(measure));
  measure();
};

const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
};

/**
 * Whether a phone's keyboard is up in the narrow window, which then gives the transcript the room:
 * the top bar folds away and the message box shrinks to one line. Always false on the desktop.
 */
export const useKeyboardOpen = () => {
  const open = useSyncExternalStore(subscribe, () => keyboardOpen);
  const compact = useCompact();
  return open && compact;
};
