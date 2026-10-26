import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Button } from "@base-ui/react/button";
import { leftLabel, resetLabel, type ModelInfo, type ProviderId, type UsageMeter } from "@cerium/protocol";
import { ArrowRight, Bot, CircleSlash, Gauge, MessagesSquare, Square, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { providerName } from "../threads/model.ts";
import type { LowMeter } from "./handoff.ts";

// Handing a thread's lead to another harness. The dialog asks first: what crosses over (the
// conversation as text), what stays behind (the old harness's own memory and tools), and what becomes
// of the work in progress. The notice above the message box offers it while the lead's harness runs
// low on its limits.

/** Above the message box while the lead's harness runs low: where its limit stands, and a way on. */
export function LowLimitNotice({
  from,
  meter,
  level,
  target,
  now,
  onContinue,
}: {
  from: ProviderId;
  meter: UsageMeter;
  level: LowMeter["level"];
  /** The model it could carry on with. */
  target: ModelInfo;
  now: number;
  onContinue: () => void;
}) {
  return (
    <div className="mx-auto mb-2 flex max-w-[46.2rem] justify-center">
      <div className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-line-subtle bg-surface-raised py-1 pr-1 pl-3 text-meta text-fg-secondary backdrop-blur-2xl max-md:text-[13px]">
        <Gauge
          size={13}
          strokeWidth={1.75}
          className={`shrink-0 ${level === "critical" ? "text-error" : "text-warning"}`}
        />
        <span className="min-w-0 truncate">
          <span className="font-medium text-fg-primary">
            {providerName[from]} · {meter.label}
          </span>{" "}
          {leftLabel(meter)}
          {meter.resetsAt === undefined ? "" : ` · ${resetLabel(meter.resetsAt, now, meter.resetDayOnly)}`}
        </span>
        <Button
          onClick={onContinue}
          className="flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-surface-hover px-2.5 font-medium text-fg-primary transition-colors hover:bg-surface-active max-md:h-8"
        >
          <ProviderLogo provider={target.provider} size={12} />
          Continue on {providerName[target.provider]}
          <ArrowRight size={12} strokeWidth={2} className="text-fg-tertiary" />
        </Button>
      </div>
    </div>
  );
}

/** Where the lead goes, and what it leaves. */
export interface Handoff {
  readonly from: ProviderId;
  readonly to: ProviderId;
  /** The model as people know it. */
  readonly label: string;
}

function Line({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <Icon size={14} strokeWidth={1.75} className="mt-[3px] shrink-0 text-fg-tertiary" />
      <p className="min-w-0 flex-1">{children}</p>
    </li>
  );
}

export function HandoffDialog({
  handoff,
  running,
  agents,
  onOpenChange,
  onConfirm,
}: {
  /** Open while there is one to confirm. */
  handoff: Handoff | undefined;
  /** The lead is in the middle of a turn, which stops. */
  running: boolean;
  /** How many of the agents the lead spawned are still running. */
  agents: number;
  onOpenChange: (open: boolean) => void;
  /** Hands the lead over; resolves whether it went through, having reported why not. */
  onConfirm: (handoff: Handoff) => Promise<boolean>;
}) {
  const [moving, setMoving] = useState(false);
  // Kept while the dialog closes, so its text doesn't vanish mid-fade.
  const [shown, setShown] = useState(handoff);
  if (handoff !== undefined && handoff !== shown) setShown(handoff);
  const from = shown ? providerName[shown.from] : "";
  const to = shown ? providerName[shown.to] : "";

  const confirm = () => {
    if (shown === undefined) return;
    setMoving(true);
    void onConfirm(shown).then((done) => {
      setMoving(false);
      if (done) onOpenChange(false);
    });
  };

  return (
    <AlertDialog.Root open={handoff !== undefined} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 bg-scrim transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <AlertDialog.Popup className="fixed top-1/2 left-1/2 flex w-[25rem] max-w-[calc(100vw-2rem)] -translate-1/2 flex-col gap-4 rounded-2xl border border-line-subtle bg-surface-overlay p-5 text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0">
          <div className="flex flex-col gap-1.5">
            <AlertDialog.Title className="flex items-center gap-2 text-reading font-semibold tracking-tight max-md:text-[16px]">
              {shown ? <ProviderLogo provider={shown.to} size={16} /> : null}
              <span className="min-w-0 truncate">Continue on {shown?.label}?</span>
            </AlertDialog.Title>
            <AlertDialog.Description className="text-body leading-relaxed text-fg-secondary max-md:text-[14px]">
              A new {to} session takes over this thread, in the same folder.
            </AlertDialog.Description>
          </div>
          <ul className="flex flex-col gap-2.5 text-body leading-snug text-fg-primary">
            <Line icon={MessagesSquare}>
              Goes across: the conversation, condensed if it's long, with the files it changed and its plan
            </Line>
            <Line icon={CircleSlash}>Stays behind: {from}'s own memory, tool results and open requests</Line>
            {running ? <Line icon={Square}>The turn in progress stops first</Line> : null}
            {agents > 0 ? (
              <Line icon={Bot}>
                {agents === 1
                  ? `The running agent keeps working and reports to ${to}`
                  : `The ${agents} running agents keep working and report to ${to}`}
              </Line>
            ) : null}
          </ul>
          <div className="flex justify-end gap-2">
            <AlertDialog.Close className="h-8 rounded-lg border border-line-strong px-3 text-body font-medium text-fg-primary transition-colors hover:bg-surface-hover max-md:h-10 max-md:px-4 max-md:text-[15px]">
              Cancel
            </AlertDialog.Close>
            <Button
              disabled={moving}
              onClick={confirm}
              className="h-8 rounded-lg bg-accent px-3 text-body font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-50 max-md:h-10 max-md:px-4 max-md:text-[15px]"
            >
              {moving ? "Handing over…" : `Continue on ${to}`}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
