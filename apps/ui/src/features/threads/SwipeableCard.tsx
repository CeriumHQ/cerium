import type { LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";

/** An action a swipe reveals on a card's underlay. */
export interface SwipeAction {
  readonly label: string;
  readonly icon: LucideIcon;
  /** What the underlay floods with once a full swipe would run it; neutral never floods. */
  readonly tone: "success" | "accent" | "neutral";
  /** It takes the card to another list: a full swipe runs it, and the card slides out as it does. */
  readonly leaves: boolean;
  readonly run: () => void;
  /** What tapping its revealed button does instead of `run`, such as offering choices; the card stays. */
  readonly tap?: () => void;
}

/** The gesture's thresholds, in CSS pixels and fractions of the card's width. */
export const SWIPE = {
  /** Travel before the gesture picks an axis. */
  intent: 10,
  /** How much more horizontal than vertical it must be to count as a swipe. */
  ratio: 1.5,
  /** The width each revealed action takes. */
  reveal: 72,
  /** The share of the card's width a full swipe passes to run its action. */
  commit: 0.55,
  /** How far the card follows past its revealed actions, per pixel of travel. */
  rubber: 0.35,
  /** Swipes right from this close to the screen's edge belong to the system's Back. */
  edge: 24,
  /** A fling this fast, in px/ms, opens or closes it whatever the distance. */
  fling: 0.5,
  settle: 250,
  leave: 200,
  /** How long a card that slid out waits for its action before coming back. */
  revert: 1500,
} as const;

export type SwipeIntent = "undecided" | "horizontal" | "ignore";

/** Whether a touch that moved `dx`, `dy` from `startX` is a swipe of the card, a scroll, or not yet either. */
export function swipeIntent(dx: number, dy: number, startX: number, resting = true): SwipeIntent {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax > SWIPE.intent && ax > SWIPE.ratio * ay) {
    return resting && dx > 0 && startX < SWIPE.edge ? "ignore" : "horizontal";
  }
  return ax > SWIPE.intent || ay > SWIPE.intent ? "ignore" : "undecided";
}

/** Follows `travel` 1:1 up to `limit`, and at a rubber band's resistance beyond it. */
export function rubberBand(travel: number, limit: number): number {
  const distance = Math.abs(travel);
  if (distance <= limit) return travel;
  return Math.sign(travel) * (limit + (distance - limit) * SWIPE.rubber);
}

export interface SwipeSides {
  readonly leading: boolean;
  readonly trailing: number;
  /** Whether a full swipe to each side runs an action. */
  readonly leadingCommits: boolean;
  readonly trailingCommits: boolean;
}

/** Where the card stands for a finger `travel` from rest: revealed actions bound it by a rubber band. */
export function swipeOffset(travel: number, sides: SwipeSides): number {
  return rubberBand(travel, travel > 0 ? (sides.leading ? SWIPE.reveal : 0) : sides.trailing * SWIPE.reveal);
}

/** Whether `travel` has gone far enough that letting go runs that side's action. */
export function swipeArmed(travel: number, width: number, sides: SwipeSides): boolean {
  const threshold = width * SWIPE.commit;
  return travel > 0
    ? sides.leadingCommits && travel >= threshold
    : sides.trailingCommits && -travel >= threshold;
}

export type SwipeRelease = "commitLeading" | "commitTrailing" | "openLeading" | "openTrailing" | "close";

/** What letting go does, from the finger's travel, the card's place and its velocity (px/ms). */
export function swipeRelease(
  travel: number,
  offset: number,
  velocity: number,
  width: number,
  sides: SwipeSides,
): SwipeRelease {
  if (swipeArmed(travel, width, sides)) return travel > 0 ? "commitLeading" : "commitTrailing";
  const leadingOpen = sides.leading && (offset >= SWIPE.reveal / 2 || (offset > 0 && velocity > SWIPE.fling));
  const trailingOpen =
    sides.trailing > 0 &&
    (-offset >= (sides.trailing * SWIPE.reveal) / 2 || (offset < 0 && velocity < -SWIPE.fling));
  // A fling back toward rest closes it, however far it stood.
  if (offset > 0 && velocity < -SWIPE.fling) return "close";
  if (offset < 0 && velocity > SWIPE.fling) return "close";
  if (offset > 0 && leadingOpen) return "openLeading";
  if (offset < 0 && trailingOpen) return "openTrailing";
  return "close";
}

/** A tick under the finger where the device has one (Android); iOS has no vibration API. */
export function haptic(ms: number) {
  if ("vibrate" in navigator) navigator.vibrate(ms);
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const coarsePointer = () => matchMedia("(pointer: coarse)").matches;

/** The card left open, so opening another closes it: only one stands open at a time. */
let closeOpen: (() => void) | undefined;

const tints = {
  success: "bg-success/18 text-success-text",
  accent: "bg-accent-soft text-accent-text",
  neutral: "bg-surface-active text-fg-primary",
} as const;

/**
 * A card that touch can swipe: right runs `leading`, left reveals `trailing`. The card follows the
 * finger over a neutral underlay that floods with the action's colour once letting go would run it.
 * Mouse and keyboard leave it alone, so every action must stay reachable from the card's menu.
 */
export function SwipeableCard({
  leading,
  trailing,
  disabled = false,
  children,
}: {
  leading: SwipeAction | undefined;
  trailing: ReadonlyArray<SwipeAction>;
  disabled?: boolean;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const offset = useRef(0);
  const gesture = useRef<{
    id: number;
    x: number;
    y: number;
    base: number;
    intent: SwipeIntent;
    lastX: number;
    lastT: number;
    velocity: number;
    travel: number;
  }>(undefined);
  const swallowClick = useRef(false);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const [side, setSide] = useState<"leading" | "trailing">();
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState(false);
  // One function for the card across renders, so the module can tell whether it is the open one.
  const closeLatest = useRef<() => void>(undefined);
  const [closer] = useState(() => () => closeLatest.current?.());

  const trailingFull = trailing.find((action) => action.leaves);
  const sides: SwipeSides = {
    leading: leading !== undefined,
    trailing: trailing.length,
    leadingCommits: leading?.leaves === true,
    trailingCommits: trailingFull !== undefined,
  };

  const later = (run: () => void, ms: number) => {
    timers.current.push(setTimeout(run, ms));
  };
  const place = (x: number, duration = 0, easing = "var(--ease-out-soft)") => {
    const element = layer.current;
    offset.current = x;
    if (element === null) return;
    element.style.transition =
      duration > 0 && !reducedMotion() ? `translate ${duration}ms ${easing}` : "none";
    element.style.translate = x === 0 ? "" : `${x}px 0`;
  };
  const close = () => {
    place(0, SWIPE.settle);
    setOpen(false);
    setArmed(false);
    if (closeOpen === closer) closeOpen = undefined;
    later(() => {
      if (offset.current === 0) setSide(undefined);
    }, SWIPE.settle);
  };
  useLayoutEffect(() => {
    closeLatest.current = close;
  });
  const claimOpen = () => {
    if (closeOpen !== undefined && closeOpen !== closer) closeOpen();
    closeOpen = closer;
  };
  const commit = (action: SwipeAction, direction: 1 | -1) => {
    if (closeOpen === closer) closeOpen = undefined;
    setOpen(false);
    const width = root.current?.offsetWidth ?? 0;
    const slides = !reducedMotion();
    if (slides) place(direction * (width + 8), SWIPE.leave, "var(--ease-in-soft)");
    later(action.run, slides ? SWIPE.leave : 0);
    // The list folds the card away once the action lands; if it fails the card comes back.
    later(() => {
      setArmed(false);
      close();
    }, SWIPE.revert);
  };
  const tap = (action: SwipeAction, direction: 1 | -1) => {
    if (action.leaves && action.tap === undefined) {
      setArmed(true);
      commit(action, direction);
      return;
    }
    close();
    later(action.tap ?? action.run, reducedMotion() ? 0 : SWIPE.settle);
  };

  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
      if (closeOpen === closer) closeOpen = undefined;
    },
    [closer],
  );
  // Touching anything else closes the open card.
  useEffect(() => {
    if (!open) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (!(event.target instanceof Node) || !root.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  });

  const end = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const current = gesture.current;
    if (current === undefined || current.id !== event.pointerId) return;
    gesture.current = undefined;
    if (current.intent !== "horizontal") return;
    const width = root.current?.offsetWidth ?? 0;
    // A cancelled touch never runs an action; it only settles where it stands.
    const release = cancelled
      ? swipeRelease(offset.current, offset.current, 0, width, {
          ...sides,
          leadingCommits: false,
          trailingCommits: false,
        })
      : swipeRelease(current.travel, offset.current, current.velocity, width, sides);
    if (release === "commitLeading" && leading) commit(leading, 1);
    else if (release === "commitTrailing" && trailingFull) commit(trailingFull, -1);
    else if (release === "openLeading" || release === "openTrailing") {
      claimOpen();
      setOpen(true);
      setArmed(false);
      place(release === "openLeading" ? SWIPE.reveal : -sides.trailing * SWIPE.reveal, SWIPE.settle);
    } else close();
  };

  const enabled = !disabled && (leading !== undefined || trailing.length > 0);
  const leadingTone = armed && side === "leading" && leading ? tints[leading.tone] : tints.neutral;
  const trailingTone =
    armed && side === "trailing" && trailingFull ? tints[trailingFull.tone] : tints.neutral;
  const iconScale = `transition-[scale] duration-200 ease-pop motion-reduce:transition-none ${
    armed || open ? "scale-100" : "scale-85"
  }`;

  return (
    <div ref={root} className="relative">
      {side === undefined ? null : (
        <div
          inert={!open}
          className={`absolute inset-0 flex overflow-hidden rounded-xl transition-colors duration-150 ease-out-soft ${
            side === "leading" ? leadingTone : trailingTone
          }`}
        >
          {side === "leading" && leading ? (
            <button
              type="button"
              onClick={() => tap(leading, 1)}
              className="flex h-full w-[72px] flex-col items-center justify-center gap-0.5 text-[12px] font-medium"
            >
              <leading.icon size={18} strokeWidth={1.75} aria-hidden className={iconScale} />
              {leading.label}
            </button>
          ) : null}
          {side === "trailing" ? (
            <div className="ml-auto flex h-full">
              {trailing.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  onClick={() => tap(action, -1)}
                  className="flex h-full w-[72px] flex-col items-center justify-center gap-0.5 text-[12px] font-medium"
                >
                  <action.icon size={18} strokeWidth={1.75} aria-hidden className={iconScale} />
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}
      <div
        ref={layer}
        className={`relative pointer-coarse:touch-pan-y ${side === undefined ? "" : "rounded-xl bg-surface-window"}`}
        onPointerDown={(event) => {
          if (!enabled || event.pointerType === "mouse" || event.button !== 0 || !coarsePointer()) return;
          // A touch on an open card closes it rather than opening the thread under it.
          swallowClick.current = open;
          if (open) {
            close();
            return;
          }
          // Caught mid-settle, it carries on from where it stands.
          const element = layer.current;
          const standing = element ? parseFloat(getComputedStyle(element).translate) || 0 : 0;
          place(standing);
          gesture.current = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            base: standing,
            intent: "undecided",
            lastX: event.clientX,
            lastT: event.timeStamp,
            velocity: 0,
            travel: standing,
          };
        }}
        onPointerMove={(event) => {
          const current = gesture.current;
          if (current === undefined || current.id !== event.pointerId) return;
          const dx = event.clientX - current.x;
          if (current.intent === "undecided") {
            current.intent = swipeIntent(dx, event.clientY - current.y, current.x, current.base === 0);
            if (current.intent === "ignore") {
              gesture.current = undefined;
              return;
            }
            if (current.intent === "undecided") return;
            event.currentTarget.setPointerCapture(event.pointerId);
            swallowClick.current = true;
            if (closeOpen !== undefined && closeOpen !== closer) closeOpen();
          }
          const elapsed = event.timeStamp - current.lastT;
          if (elapsed > 0) {
            current.velocity = 0.7 * ((event.clientX - current.lastX) / elapsed) + 0.3 * current.velocity;
          }
          current.lastX = event.clientX;
          current.lastT = event.timeStamp;
          current.travel = current.base + dx;
          const x = swipeOffset(current.travel, sides);
          place(x);
          const nextSide = x > 0 ? "leading" : x < 0 ? "trailing" : side;
          if (nextSide !== side) setSide(nextSide);
          const nextArmed = swipeArmed(current.travel, root.current?.offsetWidth ?? 0, sides);
          if (nextArmed !== armed) {
            if (nextArmed) haptic(10);
            setArmed(nextArmed);
          }
        }}
        onPointerUp={(event) => end(event, false)}
        onPointerCancel={(event) => end(event, true)}
        onClickCapture={(event) => {
          if (!swallowClick.current) return;
          swallowClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {children}
      </div>
    </div>
  );
}
