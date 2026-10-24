import { useEffect, useState } from "react";

import { elapsed } from "../dictation/model.ts";
import type { LiveActivity } from "./activity.ts";

/** The running turn's current step and its clock, in the same glass capsule a new thread's place uses. */
export function ActivityCapsule({ activity }: { readonly activity: LiveActivity }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    // Not a live region: its clock would be read out every second.
    <div className="mb-2 ml-1.5 inline-flex h-7 max-w-full min-w-0 items-center gap-2 rounded-[10px] border border-line-subtle bg-surface-panel px-2.5 text-[12px] text-fg-secondary backdrop-blur-2xl">
      <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-running" />
      <span className="min-w-0 truncate">
        {activity.verb}
        {activity.detail ? <span className="font-medium text-fg-primary"> {activity.detail}</span> : null}
      </span>
      <span className="shrink-0 text-fg-tertiary tabular-nums">{elapsed(now - activity.since)}</span>
    </div>
  );
}
