import { Button } from "@base-ui/react/button";
import { Monitor, MonitorOff, MonitorUp, SquarePen } from "lucide-react";

import type { Reach } from "../account/model.ts";

/**
 * Where the message box would be, for a thread on another machine read from the cloud copy
 * (docs/architecture.md §14.9). Continuing it takes that machine, so the bar says why it can't be
 * reached, or offers to open the thread there once it can.
 */
export function CloudThreadBar({
  machine,
  reach,
  onOpen,
  onStartNew,
}: {
  machine: string;
  reach: Reach;
  /** Drives the thread's machine and opens the thread there. */
  onOpen: () => void;
  onStartNew: () => void;
}) {
  const Icon = reach.kind === "reachable" ? Monitor : reach.kind === "outdated" ? MonitorUp : MonitorOff;
  const name = <span className="font-medium text-fg-primary">{machine}</span>;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 px-8 pb-5">
      <div className="pointer-events-auto mx-auto flex max-w-[46.2rem] items-center gap-2.5 rounded-2xl border border-line-subtle bg-surface-raised py-2 pr-2 pl-4 backdrop-blur-2xl">
        <Icon size={14} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
        <p className="min-w-0 flex-1 text-[13px] text-fg-secondary">
          {reach.kind === "reachable" ? (
            <>{name} is back online. Open the thread there to continue it.</>
          ) : reach.kind === "outdated" ? (
            <>
              {name} runs an older Cerium. You can read this thread here; to continue it, update Cerium on{" "}
              {machine}.
            </>
          ) : (
            <>
              {name} is offline ({reach.presence.toLowerCase()}). You can read this thread here; to continue
              it, {machine} needs to be on and connected.
            </>
          )}
        </p>
        <Button
          onClick={reach.kind === "reachable" ? onOpen : onStartNew}
          className="flex h-8 max-w-[45%] shrink-0 items-center gap-1.5 rounded-xl bg-accent px-3 text-[12.5px] font-medium text-accent-fg transition-opacity hover:opacity-90 active:opacity-80"
        >
          {reach.kind === "reachable" ? (
            <>
              <Monitor size={13} strokeWidth={2} className="shrink-0" />
              <span className="truncate">Open on {machine}</span>
            </>
          ) : (
            <>
              <SquarePen size={13} strokeWidth={2} className="shrink-0" />
              New thread
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
