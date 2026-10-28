import { ChevronRight } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { duration } from "./push.ts";

// The trace a run of steps is drawn as: a node per step, joined by a rail from the first to the last
// (styles/app.css, `[data-trace]`), and how long each step took beside it.

/** Steps quicker than this say nothing of their time: a read or a search is as good as instant. */
const NOTABLE_MS = 1_000;

/** How long something took, or while it runs, how long it has been going, ticking each second. */
export function Took({
  startedAt,
  endedAt,
  className = "",
}: {
  startedAt: number | undefined;
  /** Absent while it runs. */
  endedAt: number | undefined;
  className?: string;
}) {
  const running = endedAt === undefined;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (startedAt === undefined) return null;
  const ms = (endedAt ?? now) - startedAt;
  if (!running && ms < NOTABLE_MS) return null;
  // Not a live region: a running step's clock would be read out every second.
  return (
    <span className={`shrink-0 text-caption text-fg-tertiary tabular-nums ${className}`}>{duration(ms)}</span>
  );
}

/**
 * A step's node on the rail: the step's icon, centred on its header's line, with the rail running on
 * above and below it through the step's opened body. It is as wide as the icons of the transcript's
 * other one-line blocks, so a run's steps line up with them.
 */
export function TraceNode({ children }: { children: ReactNode }) {
  return (
    <span data-node className="relative flex w-[13px] shrink-0 justify-center self-stretch">
      <span className="flex h-7 items-center max-md:h-9">{children}</span>
    </span>
  );
}

/**
 * A step's header, beside its node: hovered, it lights as one line. Its words start where the other
 * one-line blocks' do, two spacing steps past the node.
 */
export const STEP_HEADER =
  "group/step flex w-full min-w-0 flex-col rounded-md pl-0.5 text-left text-meta text-fg-secondary transition-colors hover:bg-surface-hover data-popup-open:bg-surface-hover";

/** The chevron a step's header shows on hover, turned while the step is open. */
export function StepChevron() {
  return (
    <ChevronRight
      size={13}
      className="shrink-0 text-fg-tertiary opacity-0 transition-[opacity,rotate] duration-200 group-hover/step:opacity-100 group-data-panel-open/step:rotate-90 group-data-panel-open/step:opacity-100 pointer-coarse:opacity-100"
    />
  );
}
