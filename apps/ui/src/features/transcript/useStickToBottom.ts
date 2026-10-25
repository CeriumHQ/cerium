import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** How close to the end still counts as "at the bottom", so small layout shifts don't unpin. */
const SLACK = 48;

/** How quickly following closes on the end: the time it takes to close about two thirds of the gap. */
const FOLLOW_MS = 70;

/**
 * Dispatched (bubbling) from inside the viewport by whatever brings a part of the conversation into
 * view, such as the artifacts panel: the viewport stops following the end, so it stays there.
 */
export const REVEAL_EVENT = "cerium:reveal";

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
    // Following glides to the end rather than jumping there, so what comes in pushes the conversation
    // up smoothly. It eases out over about a fifth of a second, chasing the end as it moves on, and
    // gives way at once to the user scrolling up, which unpins.
    let frame = 0;
    let last = 0;
    const glide = (now: number) => {
      const end = element.scrollHeight - element.clientHeight;
      const gap = end - element.scrollTop;
      if (!pinned.current || gap <= 1) {
        if (pinned.current) element.scrollTop = end;
        frame = 0;
        return;
      }
      const elapsed = last === 0 ? 16 : now - last;
      last = now;
      element.scrollTop += Math.max(1, gap * (1 - Math.exp(-elapsed / FOLLOW_MS)));
      frame = requestAnimationFrame(glide);
    };
    const observer = new ResizeObserver(() => {
      if (!pinned.current || frame !== 0) return;
      // More than a screenful at once is a load, such as a thread's history, which just shows its end.
      const gap = element.scrollHeight - element.clientHeight - element.scrollTop;
      if (gap > element.clientHeight || matchMedia("(prefers-reduced-motion: reduce)").matches) {
        element.scrollTop = element.scrollHeight;
        return;
      }
      last = 0;
      frame = requestAnimationFrame(glide);
    });
    // A scroll made to show something comes too late to unpin: the content growing in the same
    // frame would take the viewport back to the end first.
    const onReveal = () => {
      pinned.current = false;
      setFollowing(false);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener(REVEAL_EVENT, onReveal);
    observer.observe(content);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener(REVEAL_EVENT, onReveal);
      observer.disconnect();
      cancelAnimationFrame(frame);
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
