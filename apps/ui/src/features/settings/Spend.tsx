import { Button } from "@base-ui/react/button";
import { Collapsible } from "@base-ui/react/collapsible";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { ProviderId, SpendReport, SpendTotals } from "@cerium/protocol";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { ChevronRight, CircleDollarSign, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";

import { machineAtom } from "../../backend/machine.ts";
import { spendAtom } from "../../backend/spend.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { InfoTip } from "../../components/ui/InfoTip.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { harnessName } from "./Harnesses.tsx";
import { SettingsCard, SettingsPage, SettingsSection } from "./parts.tsx";
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

type Breakdown = "model" | "harness" | "thread" | "agent";

const breakdowns: ReadonlyArray<{ readonly id: Breakdown; readonly label: string }> = [
  { id: "model", label: "Model" },
  { id: "harness", label: "Harness" },
  { id: "thread", label: "Thread" },
  { id: "agent", label: "Agent" },
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
    case "harness":
      return report.providers.map((each) => ({
        key: each.provider,
        name: harnessName[each.provider],
        provider: each.provider,
        totals: each,
      }));
    case "thread":
      return report.threads.map((each) => ({
        key: each.threadId,
        name: each.title || "Untitled",
        totals: each,
      }));
    case "agent":
      return report.agents.map((each) => ({
        key: each.agentId,
        name: each.title || "Untitled",
        detail: `${each.role} · ${each.model}`,
        provider: each.provider,
        totals: each,
      }));
  }
};

export function SpendSettings() {
  const [range, setRange] = useState<SpendRange>("week");
  const [by, setBy] = useState<Breakdown>("model");
  const atom = spendAtom(range);
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const driven = useAtomValue(machineAtom);
  const report = AsyncResult.getOrElse(result, (): SpendReport | undefined => undefined);

  return (
    <SettingsPage
      perMachine
      title="Tokens & cost"
      description={
        <span className="inline-flex flex-wrap items-center gap-x-1.5">
          What agents have used.
          <InfoTip label="About tokens and cost">
            Counted from each turn the harness reported. Cost is only what a harness reports, at its own
            rates: on a subscription it shows what the use is worth, not a charge. Codex and Cursor report
            none, so they show tokens only. Deleted threads are not counted.
          </InfoTip>
        </span>
      }
      action={
        <div className="flex items-center gap-2">
          <ToggleGroup
            value={[range]}
            onValueChange={(value) => {
              const next = spendRanges.find((each) => each.id === value[0]);
              if (next) setRange(next.id);
            }}
            aria-label="Time range"
            className="flex items-center"
          >
            {spendRanges.map(({ id, label }) => (
              <Toggle
                key={id}
                value={id}
                className="rounded-md px-2 py-0.5 text-[13px] font-medium text-fg-tertiary transition-colors duration-150 select-none hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary"
              >
                {label}
              </Toggle>
            ))}
          </ToggleGroup>
          <Tooltip label="Refresh">
            <Button
              aria-label="Refresh"
              onClick={refresh}
              disabled={result.waiting}
              className="grid size-7 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-secondary disabled:opacity-50"
            >
              <RefreshCw size={14} strokeWidth={1.75} className={result.waiting ? "animate-spin" : ""} />
            </Button>
          </Tooltip>
        </div>
      }
    >
      {AsyncResult.isFailure(result) && report === undefined ? (
        <SettingsCard className="px-4 py-3.5 text-[13px] text-error">
          {driven
            ? `Couldn't read the usage on ${driven.name}. It may need a newer Cerium.`
            : "Couldn't read the usage. Try again in a moment."}
        </SettingsCard>
      ) : report === undefined ? (
        <LoadingCard />
      ) : report.totals.turns === 0 ? (
        <Empty range={range} />
      ) : (
        <div className="flex flex-col gap-8">
          <Summary report={report} range={range} />
          <SettingsSection
            title="Breakdown"
            action={
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
                    className="rounded-md px-2 py-0.5 text-[12.5px] font-medium text-fg-tertiary transition-colors duration-150 select-none hover:text-fg-secondary data-pressed:bg-surface-selected data-pressed:text-fg-primary"
                  >
                    {label}
                  </Toggle>
                ))}
              </ToggleGroup>
            }
          >
            <Rows rows={rowsOf(report, by)} />
          </SettingsSection>
        </div>
      )}
    </SettingsPage>
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
      <span className="text-xs text-fg-tertiary">{label}</span>
      <span className="text-[24px] leading-none font-semibold tracking-tight text-fg-primary tabular-nums">
        {value}
      </span>
      {note ? <span className="text-xs leading-snug text-fg-tertiary tabular-nums">{note}</span> : null}
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
        <div className="flex justify-between text-2xs text-fg-tertiary tabular-nums">
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
            <span className="truncate text-[13px] font-medium text-fg-primary">{row.name}</span>
            {row.detail ? (
              <span className="max-w-[45%] shrink-0 truncate text-xs text-fg-tertiary max-md:max-w-full">
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
        <span className="flex w-20 shrink-0 flex-col items-end text-[13px] tabular-nums">
          <span className="text-fg-primary">{tokenLabel(tokensOf(totals))}</span>
          <span className="text-xs text-fg-tertiary">{costLabel(totals)}</span>
        </span>
        <ChevronRight
          size={14}
          strokeWidth={2}
          className="shrink-0 text-fg-tertiary transition-transform duration-200 ease-out-soft group-data-panel-open:rotate-90 motion-reduce:transition-none"
        />
      </Collapsible.Trigger>
      <Collapsible.Panel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out-soft data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
        <dl className="grid grid-cols-4 gap-3 px-4 pt-1 pb-3 text-xs tabular-nums">
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
        <span className="text-[13.5px] font-medium text-fg-primary">
          Nothing used {range === "today" ? "today" : range === "week" ? "this week" : "this month"}
        </span>
        <p className="text-[12.5px] leading-relaxed text-fg-tertiary">
          Use shows up here once an agent finishes a turn.
        </p>
      </div>
    </SettingsCard>
  );
}

/** Stands in for the page while the backend adds it up, the first time. */
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
