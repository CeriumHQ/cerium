import { Button } from "@base-ui/react/button";
import { useAtomValue } from "@effect/atom-react";
import type { ThreadId } from "@cerium/protocol";
import { Archive, Trophy } from "lucide-react";
import { AsyncResult } from "effect/reactivity";

import { runEventsAtom, summaryEventsAtom } from "../../backend/atoms.ts";
import { modelLabel } from "../../backend/view.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { ContextMenuArea, MenuItem } from "../../components/ui/Menu.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { usd } from "../../lib/format.ts";
import { useModels } from "../composer/models.ts";
import { tokenLabel } from "../settings/spendModel.ts";
import { canArchive, providerName, type ThreadSummary } from "./model.ts";
import { planKeepRun, runStats, tookLabel, type RunStats } from "./runs.ts";

/**
 * A multi-agent run's threads side by side, a line each: its model, what it changed and how long it
 * took, so the one to keep stands out. A line opens its thread; hovering offers to keep it, archiving
 * the others, or to archive it alone. Its context menu has both.
 */
export function RunScoreboard({
  threads,
  selectedId,
  onSelect,
  onArchive,
  onKeep,
  comparisonThreads,
  keeping,
}: {
  threads: ReadonlyArray<ThreadSummary>;
  selectedId: string | undefined;
  onSelect: (threadId: string, newTab?: boolean) => void;
  /** Absent where the run's threads can't be archived from here. */
  onArchive: ((threadId: string) => void) | undefined;
  onKeep: ((winnerId: string) => void) | undefined;
  comparisonThreads: ReadonlyArray<ThreadSummary>;
  keeping: boolean;
}) {
  const models = useModels();
  return (
    <ul className="mr-1 mb-1 ml-8 flex flex-col max-md:ml-9">
      {threads.map((thread) => {
        const provider = thread.providers[0];
        const label =
          provider === undefined
            ? thread.title
            : thread.lead
              ? modelLabel(models, provider, thread.lead.model)
              : providerName[provider];
        const archive =
          onArchive && thread.elsewhere === undefined && canArchive(thread)
            ? () => onArchive(thread.id)
            : undefined;
        const keep =
          onKeep && threads.length > 1 && thread.elsewhere === undefined && thread.archivedAt === undefined
            ? () => onKeep(thread.id)
            : undefined;
        const keepDisabled = keeping || planKeepRun(comparisonThreads, thread.id).act.length === 0;
        const hoverActions = (archive ? 1 : 0) + (keep ? 1 : 0);
        const openThread = (
          <Button
            onClick={(event) => onSelect(thread.id, event.ctrlKey || event.metaKey)}
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault();
            }}
            onAuxClick={(event) => {
              if (event.button === 1) onSelect(thread.id, true);
            }}
            aria-current={thread.id === selectedId ? "page" : undefined}
            title={`${label}\n${thread.title}`}
            className={`grid h-6.5 w-full grid-cols-[12px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-1.5 text-left text-meta transition-colors duration-150 max-md:h-9 max-md:text-[13px] ${
              hoverActions === 2
                ? "max-md:pr-18 pointer-coarse:pr-18"
                : hoverActions === 1
                  ? "max-md:pr-10 pointer-coarse:pr-10"
                  : ""
            } ${thread.id === selectedId ? "bg-surface-selected" : "hover:bg-surface-hover"}`}
          >
            {provider === undefined ? <span /> : <ProviderLogo provider={provider} size={12} />}
            <span
              className={`min-w-0 truncate ${
                thread.unread || thread.id === selectedId
                  ? "font-medium text-fg-primary"
                  : "text-fg-secondary"
              }`}
            >
              {label}
            </span>
            <span
              className={`flex items-center gap-2 text-caption whitespace-nowrap text-fg-tertiary tabular-nums transition-opacity duration-150 max-md:text-[12px] ${
                hoverActions > 0
                  ? "md:group-hover/line:opacity-0 md:group-has-[:focus-visible]/line:opacity-0"
                  : ""
              }`}
            >
              {thread.elsewhere === undefined ? <Outcome thread={thread} /> : <Status thread={thread} />}
            </span>
          </Button>
        );
        return (
          <li key={thread.id}>
            <div className="group/line relative">
              {keep ? (
                <ContextMenuArea
                  menu={
                    <>
                      <MenuItem icon={Trophy} onClick={keep} disabled={keepDisabled}>
                        Keep this one
                      </MenuItem>
                      {archive ? (
                        <MenuItem icon={Archive} onClick={archive}>
                          Archive
                        </MenuItem>
                      ) : null}
                    </>
                  }
                >
                  {openThread}
                </ContextMenuArea>
              ) : (
                openThread
              )}
              {hoverActions > 0 ? (
                // A touch screen can't hover for them, so they stay in sight there, with room kept in the row.
                <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5">
                  {keep ? (
                    <Tooltip
                      label={keepDisabled ? "Nothing else to archive" : "Keep this one, archive the rest"}
                    >
                      <Button
                        aria-label={`Keep this one: ${label}`}
                        disabled={keepDisabled}
                        onClick={keep}
                        className={`${lineAction} disabled:pointer-events-none disabled:text-fg-disabled`}
                      >
                        <Trophy size={13} strokeWidth={1.75} />
                      </Button>
                    </Tooltip>
                  ) : null}
                  {archive ? (
                    <Tooltip label="Archive">
                      <Button aria-label={`Archive “${label}”`} onClick={archive} className={lineAction}>
                        <Archive size={13} strokeWidth={1.75} />
                      </Button>
                    </Tooltip>
                  ) : null}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** A line's hover action: out of sight until the line is pointed at or reached by keyboard. */
const lineAction =
  "grid size-5.5 place-items-center rounded-md text-fg-tertiary opacity-0 transition-[opacity,background-color,color] duration-150 hover:bg-surface-active hover:text-fg-primary focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:outline-none md:group-hover/line:opacity-100 md:group-has-[:focus-visible]/line:opacity-100 max-md:size-8 max-md:opacity-100 pointer-coarse:size-8 pointer-coarse:opacity-100";

/** What a thread still working, or waiting on the user, says in place of its outcome. */
function Status({ thread }: { thread: ThreadSummary }) {
  if (thread.status === "awaitingApproval")
    return <span className="font-medium text-attention-text">Needs you</span>;
  if (thread.status === "running") return <span className="text-running-text">Working</span>;
  if (thread.status === "failed") return <span className="text-error-text">Failed</span>;
  return null;
}

/** A thread's outcome: the lines it changed and how long it took, once it's done. */
function Outcome({ thread }: { thread: ThreadSummary }) {
  const threadId = thread.id as ThreadId;
  const events = AsyncResult.getOrElse(useAtomValue(runEventsAtom(threadId)), () => undefined);
  const stats =
    events === undefined
      ? undefined
      : runStats(events, thread.lead?.id, thread.createdAt ?? thread.updatedAt);
  const took = stats?.took === undefined ? null : <span>{tookLabel(stats.took)}</span>;
  const usage =
    stats?.took !== undefined && stats.costUsd === undefined && stats.tokens === undefined ? (
      <FinishedUsage threadId={threadId} />
    ) : (
      <Usage stats={stats} />
    );
  if (thread.status !== "idle") {
    return (
      <>
        <Status thread={thread} />
        {thread.status === "failed" ? took : null}
        {usage}
      </>
    );
  }
  if (stats === undefined) return null;
  return (
    <>
      {stats.files === 0 ? (
        <span>No changes</span>
      ) : (
        <span title={`${stats.files} ${stats.files === 1 ? "file" : "files"} changed`}>
          <span className="text-success-text">+{stats.added}</span>{" "}
          <span className="text-error-text">−{stats.removed}</span>
        </span>
      )}
      {took}
      {usage}
    </>
  );
}

/** Older backends include usage in the main summary but omit it from run state. */
function FinishedUsage({ threadId }: { threadId: ThreadId }) {
  const events = AsyncResult.getOrElse(useAtomValue(summaryEventsAtom(threadId)), () => undefined);
  return events === undefined ? null : <Usage stats={runStats(events, undefined, 0)} />;
}

/** What the model reported it spent: its cost where the harness says, otherwise its tokens. */
function Usage({ stats }: { stats: RunStats | undefined }) {
  if (stats?.costUsd !== undefined)
    return (
      <span title="Reported cost" className="text-fg-secondary">
        {usd(stats.costUsd)}
      </span>
    );
  if (stats?.tokens) {
    return (
      <span title={`${stats.tokens.toLocaleString()} tokens`}>
        {tokenLabel(stats.tokens)}
        <span className="ml-0.5 max-md:hidden">tok</span>
      </span>
    );
  }
  return null;
}
