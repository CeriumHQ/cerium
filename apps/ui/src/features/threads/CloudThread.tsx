import { Button } from "../../components/ui/Button.tsx";
import { MonitorOff, MonitorUp, RefreshCw, SquarePen } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Where the message box would be, for a thread read from the cloud copy of a machine whose Cerium is
 * too old to drive: nothing sent from here could ever reach it, so the bar says why and offers a new
 * thread instead. A machine that's only away keeps the box, whose messages wait for it.
 */
export function CloudThreadBar({ machine, onStartNew }: { machine: string; onStartNew: () => void }) {
  return (
    <Bar>
      <MonitorUp size={14} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
      <p className="min-w-0 flex-1 text-body text-fg-secondary max-md:text-[14px] max-md:leading-snug">
        Read-only here. Update Cerium on <span className="font-medium text-fg-primary">{machine}</span> to
        continue it.
      </p>
      <Button tone="primary" onClick={onStartNew} className="max-w-[45%] max-md:w-full max-md:max-w-none">
        <SquarePen size={13} strokeWidth={2} className="shrink-0" />
        New thread
      </Button>
    </Bar>
  );
}

/** Where the open thread's message box will be, while the thread list first loads. */
export function LoadingThreadBar() {
  return (
    <Bar>
      <RefreshCw size={14} strokeWidth={1.75} className="shrink-0 animate-spin text-fg-tertiary" />
      <p className="min-w-0 flex-1 py-1.5 text-body text-fg-secondary max-md:py-0 max-md:text-[14px]">
        Opening the thread…
      </p>
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
 * The web client's message box while none of the account's computers can be reached: their
 * threads stay readable from the cloud copy, but starting one takes a computer.
 */
export function NoComputerBar() {
  return (
    <Bar>
      <MonitorOff size={14} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
      <p className="min-w-0 flex-1 py-1.5 text-body text-fg-secondary max-md:py-0 max-md:text-[14px] max-md:leading-snug">
        None of your computers are online. Open Cerium on one to start a new thread.
      </p>
    </Bar>
  );
}
