import { useEffect, useRef } from "react";

/** How close to the end still counts as "at the bottom", so small layout shifts don't unpin. */
const SLACK = 48;

/**
 * Keeps a scroll viewport at its end while the content grows, until the user scrolls up to read.
 * A new `pinKey` (the user's latest message) brings it back to the end. Returns the ref for the
 * scrolling element.
 */
export function useStickToBottom(pinKey: unknown) {
  const viewport = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const element = viewport.current;
    const content = element?.firstElementChild;
    if (!element || !content) return;
    let lastTop = element.scrollTop;
    const onScroll = () => {
      const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight <= SLACK;
      // Only the user scrolling up unpins; reflows (a panel opening, code highlighting) also fire
      // scroll events and must not.
      if (atEnd) pinned.current = true;
      else if (element.scrollTop < lastTop) pinned.current = false;
      lastTop = element.scrollTop;
    };
    const observer = new ResizeObserver(() => {
      if (pinned.current) element.scrollTop = element.scrollHeight;
    });
    element.addEventListener("scroll", onScroll, { passive: true });
    observer.observe(content);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    pinned.current = true;
    const element = viewport.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [pinKey]);

  return viewport;
}
