import { useEffect, useState } from "react";

import { elapsed } from "../dictation/model.ts";
import type { LiveActivity } from "./activity.ts";

/** The running turn's current step and its clock, written in the empty message box's line. */
export function ActivityLine({ activity }: { readonly activity: LiveActivity }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    // Not a live region: its clock would be read out every second.
    <span className="flex w-full min-w-0 items-center gap-2 text-body text-fg-secondary">
      <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-running" />
      <span className="min-w-0 truncate">
        {activity.verb}
        {activity.detail ? <span className="font-medium text-fg-primary"> {activity.detail}</span> : null}
      </span>
      <span className="ml-auto shrink-0 pr-1 text-fg-tertiary tabular-nums">
        {elapsed(now - activity.since)}
      </span>
    </span>
  );
}
