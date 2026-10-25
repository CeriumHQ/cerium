import { useEffect, useEffectEvent, useRef } from "react";

// The narrow window shows one pane at a time, so a phone's Back (the gesture, the hardware button, the
// browser's arrow) should step back to the pane before rather than leave the app. Each pane the
// window goes deeper into puts an entry on the browser's history; Back takes one off and the window
// steps back to match. The address never changes.

const KEY = "ceriumDepth";

const depthOf = (state: unknown): number =>
  typeof state === "object" && state !== null && KEY in state && typeof state[KEY] === "number"
    ? state[KEY]
    : 0;

/** How long the window waits for the browser to answer its own trip through the history. */
const SETTLE_MS = 300;

/**
 * Keeps the browser's history as deep as the window: `depth` is how many panes down it is (0 for the
 * list), and `back` steps it up by one.
 */
export function useBackNavigation(depth: number, back: () => void) {
  /** How many entries sit above the page's own, counting any a reload left behind. */
  const pushed = useRef(depthOf(history.state));
  /** Set while the window moves through the history itself, so the event that causes isn't a Back. */
  const settling = useRef(false);
  const stepBack = useEffectEvent(back);

  const settle = (steps: number) => {
    settling.current = true;
    // An out-of-range trip gets no answer; don't swallow the next real Back waiting for one.
    setTimeout(() => {
      settling.current = false;
    }, SETTLE_MS);
    history.go(steps);
  };

  useEffect(() => {
    if (depth > pushed.current) {
      // A swipe back shows the picture the browser last painted of the pane it leaves, so the pane has
      // to paint its selection before the entry is made: the first frame paints it, the second is past it.
      const from = pushed.current;
      pushed.current = depth;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          for (let level = from + 1; level <= depth; level += 1) {
            history.pushState({ [KEY]: level }, "");
          }
        }),
      );
    } else if (depth < pushed.current) {
      // The window stepped back by its own buttons: drop the entries it no longer needs.
      const extra = pushed.current - depth;
      pushed.current = depth;
      settle(-extra);
    }
  }, [depth]);

  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      if (settling.current) {
        settling.current = false;
        return;
      }
      const level = depthOf(event.state);
      if (level < pushed.current) {
        pushed.current = level;
        stepBack();
      } else if (level > pushed.current) {
        // Forward into a pane the window has left: undo it.
        settle(pushed.current - level);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
}
