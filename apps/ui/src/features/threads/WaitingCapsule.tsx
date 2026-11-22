import { Button } from "@base-ui/react/button";
import { ChevronRight } from "lucide-react";
import { useEffect, useRef } from "react";

import { usePresence, useRetained } from "../../lib/motion.ts";
import { haptic } from "./SwipeableCard.tsx";

/** How long a press holds before it opens the triage sheet rather than jumping. */
export const LONG_PRESS = 450;
/** How far up a press must move to count as a swipe up, which also opens the sheet. */
const SWIPE_UP = 24;
/** How far a press may wander before it stops counting as one. */
const SLOP = 10;

export const waitingLabel = (count: number) =>
  count === 1 ? "1 thread waiting for you" : `${count} threads waiting for you`;

/**
 * How many other threads wait on the user, as a capsule for a header's trailing slot. A tap jumps
 * to the next of them; a long press or a swipe up opens the triage sheet. It pops in as the first
 * thread starts waiting and fades out once none do.
 */
export function WaitingCapsule({
  count,
  onJump,
  onOpenSheet,
  className = "",
}: {
  /** Threads waiting, not counting the one open. */
  count: number;
  onJump: () => void;
  onOpenSheet?: () => void;
  className?: string;
}) {
  const element = useRef<HTMLButtonElement>(null);
  const show = count > 0;
  const phase = usePresence(show, element, { appear: true });
  const shown = useRetained(count, show);
  const press = useRef<{
    id: number;
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
    fired: boolean;
  }>(undefined);
  useEffect(() => () => clearTimeout(press.current?.timer), []);

  const openSheet = () => {
    const current = press.current;
    if (current === undefined || current.fired || onOpenSheet === undefined) return;
    clearTimeout(current.timer);
    current.fired = true;
    haptic(10);
    onOpenSheet();
  };
  const release = () => clearTimeout(press.current?.timer);

  if (phase === "gone") return null;
  return (
    <Button
      ref={element}
      data-phase={phase}
      inert={phase === "leaving"}
      aria-label={waitingLabel(shown)}
      onClick={() => {
        // The press that opened the sheet doesn't also jump.
        if (press.current?.fired) {
          press.current = undefined;
          return;
        }
        haptic(8);
        onJump();
      }}
      onPointerDown={(event) => {
        clearTimeout(press.current?.timer);
        press.current = undefined;
        if (onOpenSheet === undefined || event.button !== 0) return;
        press.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          timer: setTimeout(openSheet, LONG_PRESS),
          fired: false,
        };
      }}
      onPointerMove={(event) => {
        const current = press.current;
        if (current === undefined || current.fired || current.id !== event.pointerId) return;
        const dx = event.clientX - current.x;
        const dy = event.clientY - current.y;
        if (-dy > SWIPE_UP && -dy > Math.abs(dx)) openSheet();
        else if (Math.hypot(dx, dy) > SLOP && dy > -SLOP) {
          clearTimeout(current.timer);
          press.current = undefined;
        }
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onContextMenu={(event) => {
        if (onOpenSheet !== undefined) event.preventDefault();
      }}
      className={`relative flex h-8 shrink-0 items-center gap-1 rounded-full bg-attention/12 pr-1.5 pl-2 text-[13px] font-medium text-attention-text tabular-nums select-none [-webkit-touch-callout:none] [transition:opacity_200ms_var(--ease-out-soft),scale_200ms_var(--ease-pop),background-color_150ms_var(--ease-out-soft)] after:absolute after:inset-x-0 after:-inset-y-1 active:bg-attention/18 starting:scale-85 starting:opacity-0 data-[phase=leaving]:opacity-0 data-[phase=leaving]:[transition:opacity_150ms_var(--ease-in-soft)] motion-reduce:starting:scale-100 ${
        onOpenSheet === undefined ? "" : "touch-none"
      } ${className}`}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-attention" />
      <span aria-hidden>{shown}</span>
      <ChevronRight size={14} strokeWidth={2} aria-hidden className="shrink-0" />
    </Button>
  );
}
