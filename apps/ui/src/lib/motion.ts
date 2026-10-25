import { useEffect, useEffectEvent, useLayoutEffect, useState, type RefObject } from "react";

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
 * Whether the value has changed since the component mounted: what a component first shows is just
 * there, and only a change after that moves.
 */
export function useChanged(value: string | boolean): boolean {
  const [first] = useState(value);
  const [changed, setChanged] = useState(false);
  if (!changed && value !== first) setChanged(true);
  return changed;
}

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

/**
 * A list's elements by key, and where each stands. Where they stand is kept current as any of them
 * changes size (one growing in or folding out, a card opening), which moves the rest without the
 * list rendering, so a render's glide starts from where they really were. Positions are layout
 * positions (`offsetTop`), so a glide under way doesn't skew the next.
 */
class Glide {
  private readonly elements = new Map<string, HTMLElement>();
  private readonly refs = new Map<string, (element: HTMLElement | null) => () => void>();
  private tops = new Map<string, number>();
  private readonly observer = new ResizeObserver(() => this.measure());

  /** The ref of the element of `key`, the same one each render. */
  readonly ref = (key: string) => {
    let ref = this.refs.get(key);
    if (ref === undefined) {
      ref = (element) => {
        if (element === null) return () => {};
        this.elements.set(key, element);
        this.observer.observe(element);
        return () => {
          this.observer.unobserve(element);
          this.elements.delete(key);
        };
      };
      this.refs.set(key, ref);
    }
    return ref;
  };

  private measure() {
    this.tops = new Map([...this.elements].map(([key, element]) => [key, element.offsetTop]));
  }

  /** Glides each element that moved since it was last measured from there to where it stands. */
  settle() {
    const before = this.tops;
    this.measure();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const [key, top] of this.tops) {
      const was = before.get(key);
      if (was === undefined || was === top) continue;
      this.elements.get(key)?.animate([{ translate: `0 ${was - top}px` }, { translate: "0 0" }], {
        duration: 300,
        easing: "cubic-bezier(0.22, 0.8, 0.24, 1)",
      });
    }
  }

  disconnect() {
    this.observer.disconnect();
  }
}

/**
 * Glides each of a list's elements from where it stood to where it stands whenever the list renders
 * and it has moved: a reordered list rearranges itself instead of jumping. Gives each element's ref
 * by its key.
 */
export function useGlide(): (key: string) => (element: HTMLElement | null) => () => void {
  const [glide] = useState(() => new Glide());
  useLayoutEffect(() => glide.settle());
  useEffect(() => () => glide.disconnect(), [glide]);
  return glide.ref;
}

/** More new items than this at once are a load, such as a thread's history, rather than arrivals. */
const ARRIVAL_BATCH = 4;

/**
 * Which of a list's items arrived while it was in view, by key: those it had when it first had any,
 * and any that came in a batch too large to be arrivals, were already there. An arrival can rise
 * into place; what was there stays still. With `replacements: false`, keys that came as others left,
 * the list growing by fewer than came, took their places rather than arrived.
 */
export function useArrivals(
  keys: ReadonlyArray<string>,
  { replacements = true }: { replacements?: boolean } = {},
): (key: string) => boolean {
  const [state, setState] = useState(() => ({
    seen: new Set(keys),
    still: new Set(keys),
    count: keys.length,
  }));
  let { seen, still } = state;
  const fresh = keys.filter((key) => !seen.has(key));
  if (fresh.length > 0 || keys.length !== state.count) {
    seen = new Set([...seen, ...fresh]);
    const replaced = !replacements && keys.length - state.count < fresh.length;
    if (state.seen.size === 0 || fresh.length > ARRIVAL_BATCH || replaced)
      still = new Set([...still, ...fresh]);
    setState({ seen, still, count: keys.length });
  }
  return (key) => !still.has(key);
}

/** An item of a list as it shows: still in the list, or just gone from it and on its way out. */
export interface Lingering<T> {
  readonly key: string;
  readonly item: T;
  readonly present: boolean;
}

/**
 * The list's items, with those that left `previous` put back after the item they followed there.
 * Unless `linger`, those that just left go at once, and only those already on their way out stay.
 */
export const lingerIn = <T>(
  previous: ReadonlyArray<Lingering<T>>,
  items: ReadonlyArray<T>,
  keyOf: (item: T) => string,
  linger = true,
): ReadonlyArray<Lingering<T>> => {
  const next: Array<Lingering<T>> = items.map((item) => ({ key: keyOf(item), item, present: true }));
  const current = new Set(next.map((entry) => entry.key));
  previous.forEach((entry, index) => {
    if (current.has(entry.key) || (!linger && entry.present)) return;
    const before = previous[index - 1]?.key;
    const at = before === undefined ? -1 : next.findIndex((each) => each.key === before);
    next.splice(at + 1, 0, { ...entry, present: false });
  });
  return next;
};

/**
 * A list's items, and the ones that just left it where they last stood, so each can play out its
 * exit (a `Reveal` whose children go) before `release` lets it go for good. `linger` says whether
 * the ones leaving as the list goes from `before` to `after` stay to play out.
 */
export function useLingering<T>(
  items: ReadonlyArray<T>,
  keyOf: (item: T) => string,
  linger?: (before: ReadonlyArray<T>, after: ReadonlyArray<T>) => boolean,
) {
  const [state, setState] = useState(() => ({ items, shown: lingerIn([], items, keyOf) }));
  let shown = state.shown;
  if (state.items !== items) {
    shown = lingerIn(state.shown, items, keyOf, linger?.(state.items, items) ?? true);
    setState({ items, shown });
  }
  const release = (key: string) =>
    setState((current) => ({
      ...current,
      shown: current.shown.filter((entry) => entry.present || entry.key !== key),
    }));
  return [shown, release] as const;
}
