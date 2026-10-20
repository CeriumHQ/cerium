import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** How close to the end still counts as "at the bottom", so small layout shifts don't unpin. */
const SLACK = 48;

/**
 * Keeps a scroll viewport at its end while the content grows, until the user scrolls up to read.
 * A new `pinKey` (the user's latest message) brings it back to the end. Returns the ref for the
 * scrolling element, whether it is following the end, and a way back to the end.
 */
export function useStickToBottom(pinKey: unknown) {
  const viewport = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    const element = viewport.current;
    const content = element?.firstElementChild;
    if (!element || !content) return;
    let lastTop = element.scrollTop;
    const onScroll = () => {
      const fromEnd = element.scrollHeight - element.scrollTop - element.clientHeight;
      const up = element.scrollTop < lastTop;
      // Only the user scrolling up unpins, even a few pixels: staying pinned would snap a small
      // scroll straight back to the end while the answer streams. A shrinking page also moves the
      // scroll position up, but it lands at the end, so it stays pinned. Reflows (a panel opening,
      // code highlighting) fire scroll events too and must not unpin.
      if (up && fromEnd > 1) pinned.current = false;
      else if (!up && fromEnd <= SLACK) pinned.current = true;
      lastTop = element.scrollTop;
      setFollowing(pinned.current);
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

  // Jumping to the end fires a scroll event, which marks the viewport as following again. It happens
  // before the first paint, so a conversation opens at its end without a frame of its start.
  useLayoutEffect(() => {
    pinned.current = true;
    const element = viewport.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [pinKey]);

  const toEnd = () => {
    pinned.current = true;
    setFollowing(true);
    viewport.current?.scrollTo({ top: viewport.current.scrollHeight, behavior: "smooth" });
  };

  return { viewport, following, toEnd };
}
