import { useEffect, useState, type RefObject } from "react";

/** Waits no longer than this for motion to end: a hidden window's animations may never be painted. */
const SETTLE_LIMIT_MS = 1_000;

/**
 * Resolves once the element's own transitions and animations have run out, ignoring endless ones (a
 * spinner, a pulse). Under reduced motion they take no time, so it resolves at once.
 */
export const settled = (element: Element): Promise<void> => {
  const finite = () =>
    element
      .getAnimations()
      .filter(
        (animation) =>
          animation.playState === "running" && animation.effect?.getComputedTiming().iterations !== Infinity,
      );
  const drain = async (): Promise<void> => {
    // A transition reversed or replaced on the way rejects its promise, and may start another.
    for (let running = finite(); running.length > 0; running = finite()) {
      await Promise.allSettled(running.map((animation) => animation.finished));
    }
  };
  return Promise.race([drain(), new Promise<void>((resolve) => setTimeout(resolve, SETTLE_LIMIT_MS))]);
};

/**
 * The value as it is while `live`, and as it last was while live once it no longer is: what a
 * leaving element keeps showing as it plays out, after its owner has already let it go.
 */
export function useRetained<T>(value: T, live: boolean): T {
  const [kept, setKept] = useState(value);
  if (live && kept !== value) setKept(value);
  return live ? value : kept;
}

/**
 * Where something that comes and goes stands: growing into place, in place, or on its way out.
 * `gone` is unmounted.
 */
export type PresencePhase = "entering" | "shown" | "leaving" | "gone";

/**
 * Keeps an element mounted while it leaves, so its CSS can play it out (`data-phase="leaving"`), and
 * marks it `entering` while it arrives, which `@starting-style` rules animate from. What shows when
 * the component first mounts is simply there unless `appear` asks for it to arrive too. `ref` is the
 * element whose motion it waits out; it renders while the phase isn't `gone`.
 */
export function usePresence(
  show: boolean,
  ref: RefObject<Element | null>,
  { appear = false } = {},
): PresencePhase {
  const [phase, setPhase] = useState<PresencePhase>(show ? (appear ? "entering" : "shown") : "gone");
  if (show && (phase === "gone" || phase === "leaving")) setPhase("entering");
  if (!show && (phase === "entering" || phase === "shown")) setPhase("leaving");

  useEffect(() => {
    if (phase !== "entering" && phase !== "leaving") return;
    let live = true;
    const element = ref.current;
    void (element ? settled(element) : Promise.resolve()).then(() => {
      if (live) setPhase(phase === "entering" ? "shown" : "gone");
    });
    return () => {
      live = false;
    };
  }, [phase, ref]);

  return phase;
}
