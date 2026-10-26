import { startTransition, useEffect, useRef, useState } from "react";

/** Rows a long list renders at first, enough to fill a tall window. */
export const PAGE = 25;

/**
 * Rows it adds each time its end nears. Mounting them is committed in one go, transition or not, so
 * a few at a time keep each task short, with a frame painted between them.
 */
const STEP = 10;

/** How far below the view the list's end is when the next page goes in, so scrolling meets no gap. */
const AHEAD = 800;

/** The nearest element that scrolls `element` vertically, the root its end is watched against. */
const scrollerOf = (element: HTMLElement): HTMLElement | null => {
  for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
};

/**
 * How many of a long list's `total` rows to render: a page at first, and another each time the
 * element given `end`, placed after the last row rendered, scrolls near the view. Mounting hundreds
 * of rows at once holds the window up; past the first page they wait until scrolled to, and come a
 * few at a time as a transition, which lets the scrolling go on. `keep`, the index of a row that must show
 * (the open thread's), renders the rows up to it too.
 */
export function usePaging<T extends HTMLElement>(total: number, keep = -1) {
  const [count, setCount] = useState(PAGE);
  // Set while rendering, as React allows for the component's own state, so the row shows in this pass;
  // it stays rendered once the selection moves on, so the list doesn't shrink under the user.
  if (keep >= count) setCount(keep + 1);
  const shown = Math.min(total, Math.max(count, keep + 1));
  const end = useRef<T>(null);
  // Watched again after each page, so an end still in view once the page is in asks for the next one.
  useEffect(() => {
    const target = end.current;
    if (target === null || shown >= total) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) startTransition(() => setCount(shown + STEP));
      },
      { root: scrollerOf(target), rootMargin: `0px 0px ${AHEAD}px 0px` },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [shown, total]);
  return { shown, more: shown < total, end };
}
