import { Button } from "@base-ui/react/button";
import type { ProviderUsage, UsageMeter, UsageSnapshot } from "@cerium/protocol";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Gauge, RefreshCw } from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { machineAtom } from "../../backend/machine.ts";
import { usageAtom } from "../../backend/usage.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { InfoTip } from "../../components/ui/InfoTip.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { harnessName } from "./Harnesses.tsx";
import { SettingsCard, SettingsPage } from "./parts.tsx";
import {
  evenLeft,
  leftLabel,
  litSegments,
  meterLevel,
  paceLabel,
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
            an API key have none to show, and Cursor and OpenCode don't report theirs yet.
          </InfoTip>
        </span>
      }
      action={
        <div className="flex items-center gap-3">
          {checkedAt ? (
            <span className="text-xs text-fg-tertiary tabular-nums max-sm:hidden">
              Updated {new Date(checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </span>
          ) : null}
          <Button
            onClick={refresh}
            disabled={checking}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line-subtle px-2.5 text-[12.5px] text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary disabled:text-fg-tertiary"
          >
            <RefreshCw size={13} strokeWidth={1.75} className={checking ? "animate-spin" : ""} />
            {checking ? "Checking…" : "Refresh"}
          </Button>
        </div>
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
        {paced ? (
          <p className="flex items-center gap-2 text-xs text-fg-tertiary">
            <PaceMark />
            Where you'd be at an even pace. Stay right of it and the limit lasts until it resets.
          </p>
        ) : null}
      </div>
    </SettingsPage>
  );
}

/** Meters side by side, at most this many to a row. */
const COLUMNS = 3;

/**
 * A harness's logo, name and plan, over its meters: side by side in columns, or across the whole
 * row when it has just the one. Narrow cards stack them.
 */
function ProviderCard({ usage, now }: { usage: ProviderUsage; now: number }) {
  const name = harnessName[usage.provider];
  const credits = usage._tag === "Subscribed" ? usage.resetCredits : undefined;
  return (
    <SettingsCard className="@container">
      <div className="flex items-center gap-2.5 px-4 py-3">
        <ProviderLogo provider={usage.provider} size={15} className="shrink-0 text-fg-primary" />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-fg-primary">{name}</span>
        {credits ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-fg-tertiary tabular-nums">
            {credits} free reset{credits === 1 ? "" : "s"}
            <InfoTip label="About free resets">
              {name} grants these. Each one restores your limits once; use one from {name} when you hit a
              limit.
            </InfoTip>
          </span>
        ) : null}
        {usage._tag === "Subscribed" && usage.plan ? (
          <span className="shrink-0 rounded-full border border-line-subtle px-2 py-px text-[11px] font-medium text-fg-secondary">
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
      ) : usage.meters.length === 1 ? (
        <div className="border-t border-line-subtle">
          <Meter meter={usage.meters[0]!} now={now} wide name={name} credits={credits} />
        </div>
      ) : (
        <ul
          className="grid border-t border-line-subtle @lg:grid-cols-[repeat(var(--columns),minmax(0,1fr))]"
          style={{ "--columns": Math.min(usage.meters.length, COLUMNS) } as CSSProperties}
        >
          {usage.meters.map((meter, index) => (
            <li
              key={`${index}:${meter.label}`}
              className={`min-w-0 border-line-subtle ${index > 0 ? "border-t" : ""} ${
                index % COLUMNS !== 0 ? "@lg:border-l" : ""
              } ${index > 0 && index < COLUMNS ? "@lg:border-t-0" : ""}`}
            >
              <Meter meter={meter} now={now} name={name} credits={credits} />
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

const litTone = { normal: "bg-fg-primary", warning: "bg-attention", critical: "bg-error" } as const;
const textTone = { normal: "text-fg-primary", warning: "text-attention", critical: "text-error" } as const;
const statusTone = { normal: "text-fg-tertiary", warning: "text-attention", critical: "text-error" } as const;

/** The upward caret that marks an even pace, under a bar and in the note that explains it. */
function PaceMark({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg
      aria-hidden
      width="10"
      height="6"
      viewBox="0 0 10 6"
      className={`shrink-0 fill-fg-tertiary ${className ?? ""}`}
      style={style}
    >
      <path d="M5 0 10 6H0Z" />
    </svg>
  );
}

/**
 * One meter: what's left of it in large type over a bar of segments that go dark as it empties, and
 * when it starts again. Under the bar a caret marks what would be left at an even pace through the
 * window, and the line below says how far ahead or behind that the meter is.
 */
function Meter({
  meter,
  now,
  wide = false,
  name,
  credits,
}: {
  meter: UsageMeter;
  now: number;
  /** The harness's only meter, laid across the card's whole row. */
  wide?: boolean;
  name: string;
  credits: number | undefined;
}) {
  const pace = paceOf(meter, now);
  const level = meterLevel(meter, pace);
  const spent = spendLabel(meter);
  const reached = meter.usedPercent >= 100;
  // Segments about as wide in a column as across the row, wide enough to read as a bar, not dots.
  const segments = wide ? 24 : 12;
  const lit = litSegments(meter, segments);
  const status: { text: string; tip?: string } | undefined =
    reached && credits
      ? { text: `Use a free reset in ${name} to start again` }
      : pace?.fast && pace.runsOutAt !== undefined
        ? { text: runsOutLabel(pace.runsOutAt, now) }
        : meter.usedPercent === 0
          ? { text: "Unused" }
          : pace
            ? {
                text: paceLabel(meter, pace),
                tip: `At an even pace you'd have ${evenLeft(pace)}% left now, with ${Math.round(pace.elapsed)}% of the window gone.`,
              }
            : meter.resetsAt !== undefined && spent
              ? { text: spent }
              : undefined;
  // The headline is what's left; the words "left" go small beside the amount.
  const amount = leftLabel(meter).replace(/ left$/u, "");

  const headline = (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="truncate text-[12.5px] text-fg-tertiary">{meter.label}</span>
      {reached ? (
        <span className={`text-[20px] leading-[30px] font-semibold tracking-tight ${textTone[level]}`}>
          {amount}
        </span>
      ) : (
        <span className="flex items-baseline gap-1.5">
          <span
            className={`text-[30px] leading-none font-semibold tracking-tight tabular-nums ${textTone[level]}`}
          >
            {amount}
          </span>
          <span className="text-[12.5px] text-fg-tertiary">left</span>
        </span>
      )}
    </div>
  );
  // The words around the bar say what it shows, so it is drawn for the eye only.
  const bar = (
    <div aria-hidden className="relative pb-2.5">
      <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${segments}, minmax(0, 1fr))` }}>
        {Array.from({ length: segments }, (_, index) => (
          <span
            key={index}
            className={`h-[7px] rounded-[2px] transition-colors duration-500 ${index < lit ? litTone[level] : "bg-surface-hover"}`}
          />
        ))}
      </div>
      {pace ? (
        <PaceMark
          className="absolute bottom-0 -translate-x-1/2 transition-[left] duration-500 ease-out-soft"
          style={{ left: `${100 - pace.elapsed}%` }}
        />
      ) : null}
    </div>
  );
  const reset =
    meter.resetsAt !== undefined ? (
      <Tooltip label={resetMoment(meter.resetsAt)} side="bottom">
        <span className="min-w-0 truncate">{resetLabel(meter.resetsAt, now)}</span>
      </Tooltip>
    ) : (
      <span className="min-w-0 truncate">{spent ?? `${Math.round(meter.usedPercent)}% used`}</span>
    );
  const statusLine = status ? (
    status.tip ? (
      <Tooltip label={status.tip} side="bottom">
        <span className={`min-w-0 truncate ${statusTone[level]}`}>{status.text}</span>
      </Tooltip>
    ) : (
      <span className={`min-w-0 truncate ${statusTone[level]}`}>{status.text}</span>
    )
  ) : null;

  return wide ? (
    <div className="flex flex-col gap-3.5 p-4 @lg:grid @lg:grid-cols-[9.5rem_minmax(0,1fr)] @lg:items-center @lg:gap-6">
      {headline}
      <div className="flex min-w-0 flex-col gap-2">
        {bar}
        <div className="flex items-center gap-3 text-xs text-fg-tertiary tabular-nums">
          {reset}
          {statusLine ? <span className="ml-auto flex min-w-0 justify-end">{statusLine}</span> : null}
        </div>
      </div>
    </div>
  ) : (
    <div className="flex min-w-0 flex-col gap-3.5 p-4">
      {headline}
      <div className="flex flex-col gap-2">
        {bar}
        <div className="flex flex-col gap-0.5 text-xs text-fg-tertiary tabular-nums">
          {reset}
          {statusLine}
        </div>
      </div>
    </div>
  );
}

/** Stands in for the cards while the harnesses answer, the first time. */
function LoadingCard() {
  return (
    <SettingsCard className="@container animate-pulse">
      <div aria-hidden className="flex items-center gap-2.5 px-4 py-3.5">
        <span className="size-4 rounded bg-surface-hover" />
        <span className="h-3 w-28 rounded bg-surface-hover" />
      </div>
      <div aria-hidden className="grid border-t border-line-subtle @lg:grid-cols-2">
        {[0, 1].map((cell) => (
          <div
            key={cell}
            className={`flex flex-col gap-3 border-line-subtle p-4 ${cell > 0 ? "border-t @lg:border-t-0 @lg:border-l" : ""}`}
          >
            <span className="h-3 w-24 rounded bg-surface-hover" />
            <span className="h-7 w-20 rounded bg-surface-hover" />
            <span className="h-[7px] rounded-[2px] bg-surface-hover" />
          </div>
        ))}
      </div>
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
