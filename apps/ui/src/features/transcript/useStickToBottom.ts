import { useEffect, useRef, useState } from "react";

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
      const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight <= SLACK;
      // Only the user scrolling up unpins; reflows (a panel opening, code highlighting) also fire
      // scroll events and must not.
      if (atEnd) pinned.current = true;
      else if (element.scrollTop < lastTop) pinned.current = false;
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

  // Jumping to the end fires a scroll event, which marks the viewport as following again.
  useEffect(() => {
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
