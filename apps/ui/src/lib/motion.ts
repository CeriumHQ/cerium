import { useEffect, useEffectEvent, useState, type RefObject } from "react";

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
 * element whose motion it waits out; it renders while the phase isn't `gone`, and `onGone` hears
 * when it has left.
 */
export function usePresence(
  show: boolean,
  ref: RefObject<Element | null>,
  { appear = false, onGone }: { appear?: boolean; onGone?: (() => void) | undefined } = {},
): PresencePhase {
  const [phase, setPhase] = useState<PresencePhase>(show ? (appear ? "entering" : "shown") : "gone");
  if (show && (phase === "gone" || phase === "leaving")) setPhase("entering");
  if (!show && (phase === "entering" || phase === "shown")) setPhase("leaving");

  const left = useEffectEvent(() => onGone?.());
  useEffect(() => {
    if (phase !== "entering" && phase !== "leaving") return;
    let live = true;
    const element = ref.current;
    void (element ? settled(element) : Promise.resolve()).then(() => {
      if (!live) return;
      setPhase(phase === "entering" ? "shown" : "gone");
      if (phase === "leaving") left();
    });
    return () => {
      live = false;
    };
  }, [phase, ref]);

  return phase;
}

/** More new items than this at once are a load, such as a thread's history, rather than arrivals. */
const ARRIVAL_BATCH = 4;

/**
 * Which of a list's items arrived while it was in view, by key: those it had when it first had any,
 * and any that came in a batch too large to be arrivals, were already there. An arrival can rise
 * into place; what was there stays still.
 */
export function useArrivals(keys: ReadonlyArray<string>): (key: string) => boolean {
  const [state, setState] = useState(() => ({ seen: new Set(keys), still: new Set(keys) }));
  let { seen, still } = state;
  const fresh = keys.filter((key) => !seen.has(key));
  if (fresh.length > 0) {
    seen = new Set([...seen, ...fresh]);
    if (state.seen.size === 0 || fresh.length > ARRIVAL_BATCH) still = new Set([...still, ...fresh]);
    setState({ seen, still });
  }
  return (key) => !still.has(key);
}

/** An item of a list as it shows: still in the list, or just gone from it and on its way out. */
export interface Lingering<T> {
  readonly key: string;
  readonly item: T;
  readonly present: boolean;
}

/** The list's items, with those that left `previous` put back after the item they followed there. */
export const lingerIn = <T>(
  previous: ReadonlyArray<Lingering<T>>,
  items: ReadonlyArray<T>,
  keyOf: (item: T) => string,
): ReadonlyArray<Lingering<T>> => {
  const next: Array<Lingering<T>> = items.map((item) => ({ key: keyOf(item), item, present: true }));
  const current = new Set(next.map((entry) => entry.key));
  previous.forEach((entry, index) => {
    if (current.has(entry.key)) return;
    const before = previous[index - 1]?.key;
    const at = before === undefined ? -1 : next.findIndex((each) => each.key === before);
    next.splice(at + 1, 0, { ...entry, present: false });
  });
  return next;
};

/**
 * A list's items, and the ones that just left it where they last stood, so each can play out its
 * exit (a `Reveal` whose children go) before `release` lets it go for good.
 */
export function useLingering<T>(items: ReadonlyArray<T>, keyOf: (item: T) => string) {
  const [state, setState] = useState(() => ({ items, shown: lingerIn([], items, keyOf) }));
  let shown = state.shown;
  if (state.items !== items) {
    shown = lingerIn(state.shown, items, keyOf);
    setState({ items, shown });
  }
  const release = (key: string) =>
    setState((current) => ({
      ...current,
      shown: current.shown.filter((entry) => entry.present || entry.key !== key),
    }));
  return [shown, release] as const;
}
