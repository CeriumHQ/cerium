import { Button } from "@base-ui/react/button";
import type { ProviderUsage, UsageMeter, UsageSnapshot } from "@cerium/protocol";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Gauge, RefreshCw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { machineAtom } from "../../backend/machine.ts";
import { usageAtom } from "../../backend/usage.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { InfoTip } from "../../components/ui/InfoTip.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { harnessName } from "./Harnesses.tsx";
import { SettingsCard, SettingsPage } from "./parts.tsx";
import {
  leftLabel,
  leftPercent,
  meterLevel,
  paceOf,
  planName,
  resetLabel,
  resetMoment,
  runsOutLabel,
  spendLabel,
} from "./usageModel.ts";

/** Ticks twice a minute, so "Resets in 4 min" and the time bands keep up. */
function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function UsageSettings({ onOpenHarnesses }: { onOpenHarnesses?: () => void }) {
  const result = useAtomValue(usageAtom);
  const refresh = useAtomRefresh(usageAtom);
  const driven = useAtomValue(machineAtom);
  const now = useNow();

  // The backend reads the harnesses again after their turns and every few minutes, and sends each
  // change; Refresh subscribes again, which reads them now.
  const snapshot = AsyncResult.getOrElse(result, (): UsageSnapshot | undefined => undefined);
  const checking = snapshot === undefined ? result.waiting : snapshot.checking;
  // While the first read runs, the page waits for it rather than saying there's nothing to show.
  const usage =
    snapshot === undefined || (snapshot.usage.length === 0 && snapshot.checking) ? undefined : snapshot.usage;
  const checkedAt = usage
    ?.flatMap((each) => (each._tag === "Subscribed" ? [each.checkedAt] : []))
    .reduce((latest, at) => Math.max(latest, at), 0);
  const paced = usage?.some(
    (each) => each._tag === "Subscribed" && each.meters.some((meter) => paceOf(meter, now) !== undefined),
  );

  return (
    <SettingsPage
      perMachine
      title="Usage"
      description={
        <span className="inline-flex flex-wrap items-center gap-x-1.5">
          What's left of each subscription's limits.
          <InfoTip label="About usage">
            Each harness reports its own limits, and Cerium shows them as they are. Harnesses signed in with
            an API key or a free plan have none to show, and Cursor doesn't report its limits yet.
          </InfoTip>
        </span>
      }
      action={
        <Button
          onClick={refresh}
          disabled={checking}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line-subtle px-2.5 text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary disabled:text-fg-tertiary"
        >
          <RefreshCw size={13} strokeWidth={1.75} className={checking ? "animate-spin" : ""} />
          {checking ? "Checking…" : "Refresh"}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {AsyncResult.isFailure(result) && snapshot === undefined ? (
          <SettingsCard className="px-4 py-3.5 text-[13px] text-error">
            {driven
              ? `Couldn't read the usage on ${driven.name}. It may need a newer Cerium.`
              : "Couldn't read the usage. Try again in a moment."}
          </SettingsCard>
        ) : usage === undefined ? (
          <LoadingCard />
        ) : usage.length === 0 ? (
          <NoSubscriptions {...(onOpenHarnesses ? { onOpenHarnesses } : {})} />
        ) : (
          usage.map((each) => <ProviderCard key={each.provider} usage={each} now={now} />)
        )}
        {checkedAt || paced ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-fg-tertiary">
            {paced ? (
              <>
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-3 rounded-full bg-fg-secondary" />
                  Left
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-3 rounded-full bg-line-strong" />
                  Time left in the window
                </span>
              </>
            ) : null}
            {checkedAt ? (
              <span className="ml-auto tabular-nums">
                Updated {new Date(checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </SettingsPage>
  );
}

/** A harness's logo, name and plan, over its meters. */
function ProviderCard({ usage, now }: { usage: ProviderUsage; now: number }) {
  return (
    <SettingsCard>
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-line-subtle bg-surface-raised text-fg-primary">
          <ProviderLogo provider={usage.provider} size={16} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-fg-primary">
          {harnessName[usage.provider]}
        </span>
        {usage._tag === "Subscribed" && usage.resetCredits ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-fg-secondary tabular-nums">
            {usage.resetCredits} free reset{usage.resetCredits === 1 ? "" : "s"}
            <InfoTip label="About free resets">
              {harnessName[usage.provider]} grants these. Each one restores your limits once; use one from{" "}
              {harnessName[usage.provider]} when you hit a limit.
            </InfoTip>
          </span>
        ) : null}
        {usage._tag === "Subscribed" && usage.plan ? (
          <span className="shrink-0 rounded-md bg-surface-hover px-2 py-0.5 text-xs font-medium text-fg-secondary">
            {planName(usage.plan)}
          </span>
        ) : null}
      </div>
      {usage._tag === "UsageUnreadable" ? (
        <p className="border-t border-line-subtle px-4 py-3 text-[12.5px] leading-relaxed text-fg-tertiary">
          {usage.message}
        </p>
      ) : usage.meters.length === 0 ? (
        <p className="border-t border-line-subtle px-4 py-3 text-[12.5px] text-fg-tertiary">
          Your plan reports no limits right now.
        </p>
      ) : (
        <ul className="divide-y divide-line-subtle border-t border-line-subtle">
          {usage.meters.map((meter, index) => (
            <li key={`${index}:${meter.label}`}>
              <Meter meter={meter} now={now} />
            </li>
          ))}
        </ul>
      )}
      {usage._tag === "Subscribed" && usage.refreshError ? (
        <p className="flex items-start gap-2 border-t border-line-subtle px-4 py-2.5 text-xs leading-relaxed text-fg-tertiary">
          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-attention" />
          <span>
            Couldn't refresh: {usage.refreshError} These are from{" "}
            {new Date(usage.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.
          </span>
        </p>
      ) : null}
    </SettingsCard>
  );
}

const fillTone = { normal: "bg-fg-secondary", warning: "bg-attention", critical: "bg-error" } as const;
const textTone = { normal: "text-fg-primary", warning: "text-attention", critical: "text-error" } as const;

/**
 * One meter: what's left of it as a bar that empties, and when it starts again. Behind the bar, a
 * lighter band shows how much of the window is left: a bar shorter than its band is running out
 * faster than time.
 */
function Meter({ meter, now }: { meter: UsageMeter; now: number }) {
  const pace = paceOf(meter, now);
  const level = meterLevel(meter, pace);
  const left = leftPercent(meter);
  const spent = spendLabel(meter);
  const runsOut = pace?.fast && pace.runsOutAt !== undefined ? runsOutLabel(pace.runsOutAt, now) : undefined;
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate text-[13px] text-fg-primary">{meter.label}</span>
        <span className={`shrink-0 text-[13px] font-medium tabular-nums ${textTone[level]}`}>
          {leftLabel(meter)}
        </span>
      </div>
      {/* The words above say what the bar shows, so it is drawn for the eye only. */}
      <div aria-hidden className="relative h-1.5 overflow-hidden rounded-full bg-surface-hover">
        {pace ? (
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-line-strong transition-[width] duration-500 ease-out-soft"
            style={{ width: `${100 - pace.elapsed}%` }}
          />
        ) : null}
        <div
          className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out-soft ${fillTone[level]}`}
          style={{ width: `${left}%` }}
        />
      </div>
      <div className="flex items-center gap-3 text-xs text-fg-tertiary tabular-nums">
        {meter.resetsAt !== undefined ? (
          <Tooltip label={resetMoment(meter.resetsAt)} side="bottom">
            <span className="min-w-0 truncate">{resetLabel(meter.resetsAt, now)}</span>
          </Tooltip>
        ) : (
          <span className="min-w-0 truncate">{spent}</span>
        )}
        {runsOut ? (
          <span className="ml-auto shrink-0 text-attention">{runsOut}</span>
        ) : (
          <span className="ml-auto shrink-0">
            {meter.resetsAt !== undefined && spent ? spent : `${Math.round(meter.usedPercent)}% used`}
          </span>
        )}
      </div>
    </div>
  );
}

/** Stands in for the cards while the harnesses answer, the first time. */
function LoadingCard() {
  return (
    <SettingsCard className="animate-pulse">
      <div aria-hidden className="flex items-center gap-3 px-4 py-3">
        <span className="size-8 rounded-lg bg-surface-hover" />
        <span className="h-3 w-28 rounded bg-surface-hover" />
      </div>
      {[0, 1].map((row) => (
        <div key={row} aria-hidden className="flex flex-col gap-2.5 border-t border-line-subtle px-4 py-3.5">
          <span className="h-3 w-36 rounded bg-surface-hover" />
          <span className="h-1.5 rounded-full bg-surface-hover" />
        </div>
      ))}
    </SettingsCard>
  );
}

function NoSubscriptions({ onOpenHarnesses }: { onOpenHarnesses?: () => void }) {
  return (
    <SettingsCard className="flex gap-3.5 p-4">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line-subtle bg-surface-raised text-fg-secondary">
        <Gauge size={17} strokeWidth={1.75} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[13.5px] font-medium text-fg-primary">No subscriptions to show</span>
        <p className="text-[12.5px] leading-relaxed text-fg-tertiary">
          Sign a harness in with a plan, like Claude Max or ChatGPT Plus, to see its limits here.
        </p>
        {onOpenHarnesses ? <LinkButton onClick={onOpenHarnesses}>Open Harnesses</LinkButton> : null}
      </div>
    </SettingsCard>
  );
}

function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button
      onClick={onClick}
      className="mt-1.5 flex h-7 w-fit items-center rounded-md border border-line-subtle px-2.5 text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
    >
      {children}
    </Button>
  );
}
