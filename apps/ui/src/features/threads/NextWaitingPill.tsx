import { Button } from "@base-ui/react/button";
import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { usePresence, useRetained } from "../../lib/motion.ts";
import type { ThreadSummary } from "./model.ts";

/** How long the pill offers the next thread before it fades on its own. */
export const NEXT_PILL_TIMEOUT = 6_000;

type Status = ThreadSummary["status"];

/** Whether the open thread just stopped waiting on the user while `next`, another thread, still does. */
export const offersNext = (
  before: Status | undefined,
  after: Status,
  next: Pick<ThreadSummary, "id" | "status"> | undefined,
  current: string,
): boolean =>
  before === "awaitingApproval" &&
  after !== "awaitingApproval" &&
  next !== undefined &&
  next.id !== current &&
  next.status === "awaitingApproval";

/**
 * Once the user answers the open thread's request while others still wait, a capsule for the
 * composer's `above` slot offers the next of them. It fades after six seconds, or as soon as
 * `dismissed` turns true (the user typing, or scrolling back up). It stands over the box, outside what the box
 * measures, so coming and going never moves anything.
 */
export function NextWaitingPill({
  current,
  next,
  onOpen,
  dismissed = false,
}: {
  /** The thread open in the pane. */
  current: Pick<ThreadSummary, "id" | "status"> | undefined;
  /** The thread `nextWaitingThread` would go to from it. */
  next: Pick<ThreadSummary, "id" | "title" | "status"> | undefined;
  onOpen: (threadId: string) => void;
  /** Turns true as the user types or scrolls up more than 80px, which fades the pill. */
  dismissed?: boolean;
}) {
  // Each offer has its own number, so a second one starts its own six seconds.
  const [offer, setOffer] = useState(0);
  const [seen, setSeen] = useState({ current, dismissed });
  if (
    current?.id !== seen.current?.id ||
    current?.status !== seen.current?.status ||
    dismissed !== seen.dismissed
  ) {
    setSeen({ current, dismissed });
    const sameThread = current !== undefined && current.id === seen.current?.id;
    if (sameThread && offersNext(seen.current?.status, current.status, next, current.id))
      setOffer(Math.abs(offer) + 1);
    else if (offer > 0 && (!sameThread || (dismissed && !seen.dismissed))) setOffer(-offer);
  }

  useEffect(() => {
    if (offer <= 0) return;
    const timer = setTimeout(
      () => setOffer((count) => (count === offer ? -count : count)),
      NEXT_PILL_TIMEOUT,
    );
    return () => clearTimeout(timer);
  }, [offer]);

  const show = offer > 0 && next?.status === "awaitingApproval" && next.id !== current?.id;
  const element = useRef<HTMLButtonElement>(null);
  const phase = usePresence(show, element, { appear: true });
  const shown = useRetained(next, show);
  if (phase === "gone" || shown === undefined) return null;
  return (
    <div className="pointer-events-none relative mx-auto h-0 max-w-[46.2rem]">
      <div className="absolute inset-x-0 bottom-0 flex justify-center pb-2">
        <Button
          ref={element}
          data-phase={phase}
          inert={phase === "leaving"}
          aria-label={`Open next waiting thread: ${shown.title}`}
          onClick={() => onOpen(shown.id)}
          className="pointer-events-auto flex h-9 max-w-full items-center gap-2 rounded-full border border-line-subtle bg-surface-raised px-3 text-[13px] text-fg-secondary backdrop-blur-2xl outline-none select-none [transition:opacity_200ms_var(--ease-out-soft),translate_200ms_var(--ease-out-soft),background-color_150ms_var(--ease-out-soft)] active:bg-surface-active focus-visible:ring-2 focus-visible:ring-focus-ring starting:translate-y-1 starting:opacity-0 data-[phase=leaving]:opacity-0 data-[phase=leaving]:[transition:opacity_150ms_var(--ease-in-soft)] motion-reduce:starting:translate-y-0"
        >
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-attention" />
          <span className="shrink-0">Next:</span>
          <span className="max-w-[60vw] min-w-0 truncate font-medium text-fg-primary">{shown.title}</span>
          <ChevronRight size={14} strokeWidth={2} aria-hidden className="shrink-0 text-fg-tertiary" />
        </Button>
      </div>
    </div>
  );
}
