import { Button } from "@base-ui/react/button";
import { Monitor, MonitorOff, MonitorUp, RefreshCw, SquarePen } from "lucide-react";
import type { ReactNode } from "react";

import type { Reach } from "../account/model.ts";

/**
 * Where the message box would be, for a thread on another machine read from the cloud copy
 * (docs/architecture.md §14.9). Continuing it takes that machine, so the bar says why it can't be
 * reached, or offers to open the thread there once it can.
 */
export function CloudThreadBar({
  machine,
  reach,
  connecting = false,
  onOpen,
  onStartNew,
}: {
  machine: string;
  reach: Reach;
  /** The window drives that machine already and is waiting for it to answer. */
  connecting?: boolean;
  /** Drives the thread's machine and opens the thread there. */
  onOpen: () => void;
  onStartNew: () => void;
}) {
  const Icon = reach.kind === "reachable" ? Monitor : reach.kind === "outdated" ? MonitorUp : MonitorOff;
  const name = <span className="font-medium text-fg-primary">{machine}</span>;
  if (connecting && reach.kind === "reachable") {
    return (
      <Bar>
        <RefreshCw size={14} strokeWidth={1.75} className="shrink-0 animate-spin text-fg-tertiary" />
        <p className="min-w-0 flex-1 py-1.5 text-[13px] text-fg-secondary max-md:py-0 max-md:text-[14px]">
          Connecting to {name}…
        </p>
      </Bar>
    );
  }
  return (
    <Bar>
      <Icon size={14} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
      <p className="min-w-0 flex-1 text-[13px] text-fg-secondary max-md:text-[14px] max-md:leading-snug">
        {reach.kind === "reachable" ? (
          <>{name} is back online. Open the thread there to continue it.</>
        ) : reach.kind === "outdated" ? (
          <>
            {name} runs an older Cerium. You can read this thread here; to continue it, update Cerium on{" "}
            {machine}.
          </>
        ) : (
          <>
            {name} is offline ({reach.presence.toLowerCase()}). You can read this thread here; to continue it,{" "}
            {machine} needs to be on and connected.
          </>
        )}
      </p>
      <Button
        onClick={reach.kind === "reachable" ? onOpen : onStartNew}
        className="flex h-8 max-w-[45%] shrink-0 items-center gap-1.5 rounded-xl bg-accent px-3 text-[12.5px] font-medium text-accent-fg transition-opacity hover:opacity-90 active:opacity-80 max-md:h-10 max-md:w-full max-md:max-w-none max-md:justify-center max-md:text-[14px]"
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
    </Bar>
  );
}

/** Where the message box sits, holding a note instead. */
function Bar({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] md:px-8 md:pb-5">
      <div className="pointer-events-auto mx-auto flex max-w-[46.2rem] items-center gap-2.5 rounded-2xl border border-line-subtle bg-surface-raised py-2 pr-2 pl-4 backdrop-blur-2xl max-md:flex-wrap max-md:p-3">
        {children}
      </div>
    </div>
  );
}

/**
 * The web client's message box while none of the account's computers can be reached (§14.10): their
 * threads stay readable from the cloud copy, but starting one takes a computer.
 */
export function NoComputerBar() {
  return (
    <Bar>
      <MonitorOff size={14} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
      <p className="min-w-0 flex-1 py-1.5 text-[13px] text-fg-secondary max-md:py-0 max-md:text-[14px] max-md:leading-snug">
        None of your computers is online. Their threads stay readable here; to start or continue one, open
        Cerium on one of them.
      </p>
    </Bar>
  );
}
