import { Collapsible } from "@base-ui/react/collapsible";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { ProviderId, SpendReport, SpendTotals, UsageSnapshot } from "@cerium/protocol";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ChevronRight, CircleDollarSign } from "lucide-react";
import { useState, type ReactNode } from "react";

import { machineAtom } from "../../backend/machine.ts";
import { spendAtom, spendSinceAtom } from "../../backend/spend.ts";
import { usageAtom } from "../../backend/usage.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { harnessName } from "./Harnesses.tsx";
import { RefreshAction, SettingsCard, SettingsPage, SettingsSection } from "./parts.tsx";
import {
  bucketLabel,
  cacheShare,
  costGap,
  costLabel,
  spendRanges,
  tokenLabel,
  tokensOf,
  type SpendRange,
} from "./spendModel.ts";
import { lastResetOf } from "./usageModel.ts";

type Breakdown = "model" | "thread" | "reset";

const breakdowns: ReadonlyArray<{ readonly id: Breakdown; readonly label: string }> = [
  { id: "model", label: "Model" },
  { id: "thread", label: "Thread" },
  { id: "reset", label: "Since reset" },
];

/** One line of a breakdown: who, what to call them, and what they used. */
interface Row {
  readonly key: string;
  readonly name: string;
  readonly detail?: string;
  readonly provider?: ProviderId;
  readonly totals: SpendTotals;
}

const rowsOf = (report: SpendReport, by: Breakdown): ReadonlyArray<Row> => {
  switch (by) {
    case "model":
      return report.models.map((each) => ({
        key: `${each.provider}\n${each.model}`,
        name: each.model,
        detail: harnessName[each.provider],
        provider: each.provider,
        totals: each,
      }));
    case "thread":
      return report.threads.map((each) => ({
        key: each.threadId,
        name: each.title || "Untitled",
        totals: each,
      }));
    case "reset":
      return [];
  }
};

/**
 * What agents used over a range of time: the totals over a chart, then each model's or thread's
 * share. Refresh reads it again.
 */
export function TokensSettings() {
  const [range, setRange] = useState<SpendRange>("week");
  const [by, setBy] = useState<Breakdown>("model");
  const result = useAtomValue(spendAtom(range));
  const refresh = useAtomRefresh(spendAtom(range));
  const driven = useAtomValue(machineAtom);
  const report = AsyncResult.getOrElse(result, (): SpendReport | undefined => undefined);

  return (
    <SettingsPage
      perMachine
      title="Tokens"
      description="Cost is what each harness reports at its own rates: on a subscription, what the use is worth, not a charge."
      action={
        <RefreshAction
          updatedAt={AsyncResult.isSuccess(result) ? result.timestamp : undefined}
          checking={result.waiting}
          onRefresh={refresh}
        />
      }
    >
      <SettingsSection
        title="Tokens & cost"
        action={
          <ToggleGroup
            value={[range]}
            onValueChange={(value) => {
              const next = spendRanges.find((each) => each.id === value[0]);
              if (next) setRange(next.id);
            }}
            aria-label="Time range"
            className="flex shrink-0 items-center"
          >
            {spendRanges.map(({ id, label }) => (
              <Toggle
                key={id}
                value={id}
                className="rounded-md px-2 py-0.5 text-meta font-medium text-fg-tertiary transition-colors duration-150 select-none hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary"
              >
                {label}
              </Toggle>
            ))}
          </ToggleGroup>
        }
      >
        {AsyncResult.isFailure(result) && report === undefined ? (
          <SettingsCard className="px-4 py-3.5 text-body text-error-text">
            {driven
              ? `Couldn't read the usage on ${driven.name}. It may need a newer Cerium.`
              : "Couldn't read the usage. Try again in a moment."}
          </SettingsCard>
        ) : report === undefined ? (
          <LoadingCard />
        ) : report.totals.turns === 0 ? (
          <Empty range={range} />
        ) : (
          <>
            <Summary report={report} range={range} />
            <div className="flex items-center gap-2 pt-2">
              <span className="text-meta text-fg-tertiary">By</span>
              <ToggleGroup
                value={[by]}
                onValueChange={(value) => {
                  const next = breakdowns.find((each) => each.id === value[0]);
                  if (next) setBy(next.id);
                }}
                aria-label="Break down by"
                className="flex items-center"
              >
                {breakdowns.map(({ id, label }) => (
                  <Toggle
                    key={id}
                    value={id}
                    className="rounded-md px-2 py-0.5 text-meta font-medium text-fg-tertiary transition-colors duration-150 select-none hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary"
                  >
                    {label}
                  </Toggle>
                ))}
              </ToggleGroup>
            </div>
            {by === "reset" ? <ResetShares /> : <Rows rows={rowsOf(report, by)} />}
          </>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}

/** Each subscribed harness's models by the share of its tokens they took since its limits last reset. */
function ResetShares() {
  const snapshot = AsyncResult.getOrElse(useAtomValue(usageAtom), (): UsageSnapshot | undefined => undefined);
  const [now] = useState(() => Date.now());
  const sections = (snapshot?.usage ?? []).flatMap((usage) => {
    const start = lastResetOf(usage, now);
    return start === undefined ? [] : [{ provider: usage.provider, start }];
  });
  if (sections.length === 0) {
    return (
      <SettingsCard className="px-4 py-3.5 text-meta text-fg-tertiary">
        No subscription reports when its limits reset.
      </SettingsCard>
    );
  }
  return sections.map(({ provider, start }) => (
    <ResetCard key={provider} provider={provider} start={start} />
  ));
}

function ResetCard({ provider, start }: { provider: ProviderId; start: number }) {
  const report = AsyncResult.getOrElse(
    useAtomValue(spendSinceAtom(start)),
    (): SpendReport | undefined => undefined,
  );
  const models = (report?.models ?? [])
    .filter((each) => each.provider === provider && tokensOf(each) > 0)
    .sort((a, b) => tokensOf(b) - tokensOf(a));
  const total = models.reduce((sum, each) => sum + tokensOf(each), 0);
  return (
    <SettingsCard className="divide-y divide-line-subtle overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-2.5">
        <ProviderLogo provider={provider} size={14} className="shrink-0 text-fg-secondary" />
        <span className="min-w-0 flex-1 truncate text-body font-medium text-fg-primary">
          {harnessName[provider]}
        </span>
        <span className="shrink-0 text-meta text-fg-tertiary">
          since{" "}
          {new Date(start).toLocaleString([], {
            weekday: "short",
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
      </div>
      {report === undefined ? (
        <p className="px-4 py-2.5 text-meta text-fg-tertiary">Reading…</p>
      ) : models.length === 0 ? (
        <p className="px-4 py-2.5 text-meta text-fg-tertiary">Nothing used since.</p>
      ) : (
        models.map((each) => {
          const share = (tokensOf(each) / total) * 100;
          return (
            <div key={each.model} className="flex items-center gap-3 px-4 py-2.5">
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="truncate text-body font-medium text-fg-primary">{each.model}</span>
                <span aria-hidden className="h-1 overflow-hidden rounded-full bg-surface-hover">
                  <span
                    className="block h-full rounded-full bg-fg-secondary"
                    style={{ width: `${Math.max(2, share)}%` }}
                  />
                </span>
              </span>
              <span className="w-12 shrink-0 text-right text-body text-fg-primary tabular-nums">
                {share < 1 ? "<1" : Math.round(share)}%
              </span>
            </div>
          );
        })
      )}
    </SettingsCard>
  );
}

/** The headline numbers over the chart of tokens through the range. */
function Summary({ report, range }: { report: SpendReport; range: SpendRange }) {
  const { totals } = report;
  const cached = cacheShare(totals);
  const unreported = report.providers.filter((each) => each.pricedTurns === 0);
  const gap = costGap(totals);
  return (
    <SettingsCard>
      <div className="grid grid-cols-2 divide-x divide-line-subtle">
        <Figure
          label="Tokens"
          value={tokenLabel(tokensOf(totals))}
          note={`${tokenLabel(totals.inputTokens)} in · ${tokenLabel(totals.outputTokens)} out${
            cached === undefined ? "" : ` · ${cached}% cached`
          }`}
        />
        <Figure
          label="Est. cost"
          value={costLabel(totals)}
          {...(gap
            ? {
                note:
                  unreported.length > 0
                    ? `${unreported.map((each) => harnessName[each.provider]).join(", ")} report${
                        unreported.length === 1 ? "s" : ""
                      } none`
                    : gap,
              }
            : { note: "As the harnesses report it" })}
        />
      </div>
      <Bars report={report} range={range} />
    </SettingsCard>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-4 py-3.5">
      <span className="text-meta text-fg-tertiary">{label}</span>
      <span className="text-[24px] leading-none font-semibold tracking-tight text-fg-primary tabular-nums">
        {value}
      </span>
      {note ? <span className="text-meta leading-snug text-fg-tertiary tabular-nums">{note}</span> : null}
    </div>
  );
}

/** Tokens in each stretch of the range as bars, the biggest filling the height. */
function Bars({ report, range }: { report: SpendReport; range: SpendRange }) {
  const { buckets } = report;
  const biggest = Math.max(1, ...buckets.map(tokensOf));
  const first = buckets[0];
  const last = buckets.at(-1);
  return (
    <div className="flex flex-col gap-1.5 border-t border-line-subtle px-4 pt-4 pb-3">
      <div className="flex h-24 items-end gap-0.5">
        {buckets.map((bucket) => {
          const tokens = tokensOf(bucket);
          return (
            <Tooltip
              key={bucket.start}
              side="top"
              label={
                <span className="flex flex-col tabular-nums">
                  <span className="text-fg-tertiary">{bucketLabel(range, bucket.start)}</span>
                  <span>
                    {tokens === 0 ? "Nothing used" : `${tokenLabel(tokens)} tokens`}
                    {bucket.pricedTurns > 0 ? ` · ${costLabel(bucket)}` : ""}
                  </span>
                </span>
              }
            >
              <div className="group flex h-full min-w-0 flex-1 items-end">
                <div
                  className={`w-full rounded-t-[3px] transition-colors duration-150 ${
                    tokens === 0 ? "h-px bg-line-strong" : "bg-fg-secondary group-hover:bg-fg-primary"
                  }`}
                  style={tokens === 0 ? undefined : { height: `${Math.max(3, (tokens / biggest) * 100)}%` }}
                />
              </div>
            </Tooltip>
          );
        })}
      </div>
      {first && last ? (
        <div className="flex justify-between text-caption text-fg-tertiary tabular-nums">
          <span>{bucketLabel(range, first.start)}</span>
          <span>{bucketLabel(range, last.start)}</span>
        </div>
      ) : null}
    </div>
  );
}

/** The biggest first, each with a thin bar against the biggest; its detail unfolds on demand. */
function Rows({ rows }: { rows: ReadonlyArray<Row> }) {
  const biggest = Math.max(1, ...rows.map((row) => tokensOf(row.totals)));
  return (
    <SettingsCard className="divide-y divide-line-subtle overflow-hidden">
      {rows.map((row) => (
        <RowItem key={row.key} row={row} share={tokensOf(row.totals) / biggest} />
      ))}
    </SettingsCard>
  );
}

function RowItem({ row, share }: { row: Row; share: number }) {
  const { totals } = row;
  const gap = costGap(totals);
  return (
    <Collapsible.Root>
      <Collapsible.Trigger className="group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-hover/60">
        {row.provider ? (
          <span className="grid size-6 shrink-0 place-items-center text-fg-secondary">
            <ProviderLogo provider={row.provider} size={14} />
          </span>
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="flex min-w-0 items-baseline gap-2 max-md:flex-col max-md:gap-0">
            <span className="truncate text-body font-medium text-fg-primary">{row.name}</span>
            {row.detail ? (
              <span className="max-w-[45%] shrink-0 truncate text-meta text-fg-tertiary max-md:max-w-full">
                {row.detail}
              </span>
            ) : null}
          </span>
          <span aria-hidden className="h-1 overflow-hidden rounded-full bg-surface-hover">
            <span
              className="block h-full rounded-full bg-fg-secondary"
              style={{ width: `${Math.max(2, share * 100)}%` }}
            />
          </span>
        </span>
        <span className="flex w-20 shrink-0 flex-col items-end text-body tabular-nums">
          <span className="text-fg-primary">{tokenLabel(tokensOf(totals))}</span>
          <span className="text-meta text-fg-tertiary">{costLabel(totals)}</span>
        </span>
        <ChevronRight
          size={14}
          strokeWidth={2}
          className="shrink-0 text-fg-tertiary transition-transform duration-200 ease-out-soft group-data-panel-open:rotate-90 motion-reduce:transition-none"
        />
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
        <dl className="grid grid-cols-4 gap-3 px-4 pt-1 pb-3 text-meta tabular-nums">
          <Detail label="Input" value={tokenLabel(totals.inputTokens)} />
          <Detail label="Cached" value={tokenLabel(totals.cachedInputTokens)} />
          <Detail label="Output" value={tokenLabel(totals.outputTokens)} />
          <Detail label="Turns" value={String(totals.turns)} />
          {gap ? <p className="col-span-4 text-fg-tertiary">{gap}</p> : null}
        </dl>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-fg-tertiary">{label}</dt>
      <dd className="text-fg-primary">{value}</dd>
    </div>
  );
}

function Empty({ range }: { range: SpendRange }) {
  return (
    <SettingsCard className="flex gap-3.5 p-4">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-line-subtle bg-surface-raised text-fg-secondary">
        <CircleDollarSign size={17} strokeWidth={1.75} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-reading font-medium text-fg-primary">
          Nothing used {range === "today" ? "today" : range === "week" ? "this week" : "this month"}
        </span>
        <p className="text-meta leading-relaxed text-fg-tertiary">
          Use shows up here once an agent finishes a turn.
        </p>
      </div>
    </SettingsCard>
  );
}

/** Stands in for the totals while the backend adds it up, the first time. */
function LoadingCard() {
  return (
    <SettingsCard className="animate-pulse">
      <div aria-hidden className="grid grid-cols-2 divide-x divide-line-subtle">
        {[0, 1].map((cell) => (
          <div key={cell} className="flex flex-col gap-2.5 px-4 py-3.5">
            <span className="h-3 w-12 rounded bg-surface-hover" />
            <span className="h-6 w-24 rounded bg-surface-hover" />
          </div>
        ))}
      </div>
      <div aria-hidden className="h-24 border-t border-line-subtle" />
    </SettingsCard>
  );
}
