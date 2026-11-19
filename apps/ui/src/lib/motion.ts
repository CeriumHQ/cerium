import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from "react";

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
 * list rendering, so a render's glide starts from where they really were. Layout offsets ignore
 * scrolling and let a new glide start from the running one's visible position.
 */
class Glide {
  private readonly axis: "x" | "y";
  private readonly elements = new Map<string, HTMLElement>();
  private readonly refs = new Map<string, (element: HTMLElement | null) => () => void>();
  private readonly animations = new Map<string, Animation>();
  private positions = new Map<string, number>();
  private readonly observer = new ResizeObserver(() => this.measure());

  constructor(axis: "x" | "y") {
    this.axis = axis;
  }

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
          this.cancel(key);
        };
      };
      this.refs.set(key, ref);
    }
    return ref;
  };

  private measure() {
    this.positions = new Map(
      [...this.elements].map(([key, element]) => [
        key,
        this.axis === "x" ? element.offsetLeft : element.offsetTop,
      ]),
    );
  }

  private cancel(key: string) {
    this.animations.get(key)?.cancel();
    this.animations.delete(key);
  }

  /** Glides each element that moved since it was last measured from there to where it stands. */
  settle(enabled: boolean, skip: string | undefined, duration: number) {
    const before = this.positions;
    this.measure();
    if (skip !== undefined) this.cancel(skip);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const key of this.animations.keys()) this.cancel(key);
      return;
    }
    if (!enabled) return;
    for (const [key, element] of this.elements) {
      const position = this.positions.get(key)!;
      const was = before.get(key);
      if (key === skip || was === undefined || was === position) continue;
      const style = getComputedStyle(element);
      const current = this.animations.has(key)
        ? parseFloat(style.translate.split(" ")[this.axis === "x" ? 0 : 1] ?? "0") || 0
        : 0;
      this.cancel(key);
      const distance = was + current - position;
      if (distance === 0) continue;
      const animation = element.animate(
        [{ translate: this.axis === "x" ? `${distance}px 0` : `0 ${distance}px` }, { translate: "0 0" }],
        { duration, easing: style.getPropertyValue("--ease-out-soft").trim() || "ease-out" },
      );
      this.animations.set(key, animation);
      animation.onfinish = () => {
        if (this.animations.get(key) === animation) this.animations.delete(key);
      };
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
export function useGlide({
  axis = "y",
  enabled = true,
  skip,
  duration = 300,
}: {
  axis?: "x" | "y";
  enabled?: boolean;
  skip?: string | undefined;
  duration?: number;
} = {}): (key: string) => (element: HTMLElement | null) => () => void {
  const [glide] = useState(() => new Glide(axis));
  useLayoutEffect(() => glide.settle(enabled, skip, duration));
  useEffect(() => () => glide.disconnect(), [glide]);
  return glide.ref;
}

interface MorphPart {
  readonly layer: HTMLElement;
  readonly x: number;
  readonly y: number;
}

/** A morphing box as it last stood: its height and corners, and where its contents start. */
interface MorphFrame {
  readonly height: number;
  readonly radius: string;
  readonly parts: ReadonlyMap<string, MorphPart>;
  readonly layers: ReadonlyMap<HTMLElement, number>;
}

const MORPH_PART = "[data-morph]";

const morphOffset = (element: HTMLElement) =>
  getComputedStyle(element)
    .translate.split(" ")
    .map((axis) => parseFloat(axis) || 0);

/** Measure where the marked content starts and move its whole layer, including any placeholder. */
const morphFrame = (box: HTMLElement, target?: MorphFrame): MorphFrame => {
  const origin = box.getBoundingClientRect();
  const style = getComputedStyle(box);
  const parts = new Map<string, MorphPart>();
  const layers = new Map<HTMLElement, number>();
  for (const layer of box.children) {
    if (!(layer instanceof HTMLElement)) continue;
    const part = layer.matches(MORPH_PART) ? layer : layer.querySelector<HTMLElement>(MORPH_PART);
    if (part === null) {
      if (layer.offsetHeight === 0 || getComputedStyle(layer).position === "absolute") continue;
      const top = target?.layers.get(layer);
      layers.set(
        layer,
        top === undefined
          ? layer.getBoundingClientRect().top - origin.top
          : top + (morphOffset(layer)[1] ?? 0),
      );
      continue;
    }
    const name = part.dataset.morph!;
    const point = target?.parts.get(name);
    // The new layout is in the DOM already. Read the running offset against its old target.
    if (point !== undefined) {
      const [x = 0, y = 0] = morphOffset(point.layer);
      parts.set(name, {
        layer,
        x: point.x + x,
        y: point.y + y,
      });
      continue;
    }
    const rect = part.getBoundingClientRect();
    const partStyle = getComputedStyle(part);
    parts.set(name, {
      layer,
      x: rect.left - origin.left + part.clientLeft + parseFloat(partStyle.paddingLeft),
      y: rect.top - origin.top + part.clientTop + parseFloat(partStyle.paddingTop),
    });
  }
  return { height: parseFloat(style.height), radius: style.borderRadius, parts, layers };
};

/** Whether any of the animations is still under way, held paused or not. */
const moving = (animations: ReadonlyArray<Animation>) =>
  animations.some((animation) => animation.playState === "running" || animation.playState === "paused");

/**
 * Morphs a box between two shapes instead of jumping when `shape` changes. Its height and corners
 * ease from the old shape's to the new one's, clipped on the way, with its foot standing still, as a
 * box anchored to the bottom of the window grows and shrinks from its top. Each part marked
 * `data-morph="name"` moves its layer with the content. The box's other children hold to the foot
 * as the box changes height around them. The return value lets nested motion defer, including on
 * the first render of the new shape. `layout` lets content changes retarget a morph in flight.
 */
export function useMorph(
  ref: RefObject<HTMLElement | null>,
  shape: string,
  {
    duration = 340,
    easing = "cubic-bezier(0.32, 0.72, 0, 1)",
    layout,
  }: { duration?: number; easing?: string; layout?: string } = {},
) {
  const [motion, setMotion] = useState({ shape, active: false });
  if (motion.shape !== shape) setMotion({ shape, active: true });
  const morph = useRef<{
    shape: string;
    layout: string | undefined;
    frame?: MorphFrame;
    running: ReadonlyArray<Animation>;
  }>({
    shape,
    layout,
    running: [],
  });

  useLayoutEffect(() => {
    const box = ref.current;
    const current = morph.current;
    if (!box) return;
    const changed = current.shape !== shape;
    const busy = moving(current.running);
    if (!changed && busy && current.layout === layout) return;
    const before = busy ? morphFrame(box, current.frame) : current.frame;
    for (const animation of current.running) animation.cancel();
    const after = morphFrame(box);
    current.shape = shape;
    current.layout = layout;
    current.frame = after;
    const running: Animation[] = [];
    current.running = running;
    const release = () => {
      if (current.running === running) setMotion({ shape, active: false });
    };
    if (
      (!changed && !busy) ||
      before === undefined ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      if (motion.active) queueMicrotask(release);
      return;
    }
    const timing: KeyframeAnimationOptions = { duration, easing, fill: "backwards" };
    const held = before.height - after.height;
    running.push(
      box.animate(
        [
          { height: `${before.height}px`, borderRadius: before.radius, overflow: "clip" },
          { height: `${after.height}px`, borderRadius: after.radius, overflow: "clip" },
        ],
        timing,
      ),
    );
    for (const [name, to] of after.parts) {
      const from = before.parts.get(name);
      if (!from || (from.x === to.x && from.y === to.y)) continue;
      running.push(
        to.layer.animate(
          [{ translate: `${from.x - to.x}px ${from.y - to.y}px` }, { translate: "0 0" }],
          timing,
        ),
      );
    }
    for (const [layer, top] of after.layers) {
      const from = busy ? before.layers.get(layer) : undefined;
      const offset = from === undefined ? held : from - top;
      if (offset === 0) continue;
      running.push(layer.animate([{ translate: `0 ${offset}px` }, { translate: "0 0" }], timing));
    }
    void Promise.allSettled(running.map((animation) => animation.finished)).then(release);
  });

  // The box changes size without rendering (the window narrowing, a line wrapping), so the frame a
  // morph starts from is kept current as it does.
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const current = morph.current;
    const observer = new ResizeObserver(() => {
      if (!moving(current.running)) {
        current.frame = morphFrame(box);
      }
    });
    observer.observe(box);
    return () => {
      observer.disconnect();
      const { running } = current;
      current.running = [];
      for (const animation of running) animation.cancel();
    };
  }, [ref]);

  return motion.active;
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
): ((key: string) => boolean) & { together: (first: string, second: string) => boolean } {
  const [state, setState] = useState(() => ({
    seen: new Map(keys.map((key) => [key, 0])),
    still: new Set(keys),
    count: keys.length,
    batch: 0,
  }));
  let { seen, still } = state;
  const fresh = keys.filter((key) => !seen.has(key));
  if (fresh.length > 0 || keys.length !== state.count) {
    const batch = state.batch + 1;
    seen = new Map(seen);
    for (const key of fresh) seen.set(key, batch);
    const replaced = !replacements && keys.length - state.count < fresh.length;
    if (state.seen.size === 0 || fresh.length > ARRIVAL_BATCH || replaced)
      still = new Set([...still, ...fresh]);
    setState({ seen, still, count: keys.length, batch });
  }
  const arrived = (key: string) => !still.has(key);
  return Object.assign(arrived, {
    together: (first: string, second: string) =>
      arrived(first) && seen.has(first) && seen.get(first) === seen.get(second),
  });
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
