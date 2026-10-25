import { Button } from "@base-ui/react/button";
import { useAtomValue } from "@effect/atom-react";
import type { ThreadId } from "@cerium/protocol";
import { Archive } from "lucide-react";
import { AsyncResult } from "effect/reactivity";

import { settledEventsAtom } from "../../backend/atoms.ts";
import { modelLabel } from "../../backend/view.ts";
import { ProviderLogo } from "../../components/ProviderLogo.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { useModels } from "../composer/models.ts";
import { canArchive, providerName, type ThreadSummary } from "./model.ts";
import { runStats, tookLabel } from "./runs.ts";

/**
 * A multi-agent run's threads side by side, a line each: its model, what it changed and how long it
 * took, so the one to keep stands out. A line opens its thread; hovering offers to archive it.
 */
export function RunScoreboard({
  threads,
  selectedId,
  onSelect,
  onArchive,
}: {
  threads: ReadonlyArray<ThreadSummary>;
  selectedId: string | undefined;
  onSelect: (threadId: string, newTab?: boolean) => void;
  /** Absent where the run's threads can't be archived from here. */
  onArchive: ((threadId: string) => void) | undefined;
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
        return (
          <li key={thread.id} className="group/line relative">
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
                thread.id === selectedId ? "bg-surface-selected" : "hover:bg-surface-hover"
              }`}
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
                className={`flex items-center gap-2 text-caption whitespace-nowrap text-fg-tertiary tabular-nums transition-opacity duration-150 max-md:text-xs ${
                  archive ? "md:group-hover/line:opacity-0 md:group-has-[:focus-visible]/line:opacity-0" : ""
                }`}
              >
                {thread.elsewhere === undefined ? <Outcome thread={thread} /> : <Status thread={thread} />}
              </span>
            </Button>
            {archive ? (
              <Tooltip label="Archive">
                <Button
                  aria-label={`Archive “${label}”`}
                  onClick={archive}
                  className="absolute top-1/2 right-1 grid size-5.5 -translate-y-1/2 place-items-center rounded-md text-fg-tertiary opacity-0 transition-[opacity,background-color,color] duration-150 hover:bg-surface-active hover:text-fg-primary focus-visible:opacity-100 md:group-hover/line:opacity-100 pointer-coarse:hidden"
                >
                  <Archive size={13} strokeWidth={1.75} />
                </Button>
              </Tooltip>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** What a thread still working, or waiting on the user, says in place of its outcome. */
function Status({ thread }: { thread: ThreadSummary }) {
  if (thread.status === "awaitingApproval")
    return <span className="font-medium text-attention">Needs you</span>;
  if (thread.status === "running") return <span className="text-running">Working</span>;
  if (thread.status === "failed") return <span className="text-error">Failed</span>;
  return null;
}

/** A thread's outcome: the lines it changed and how long it took, once it's done. */
function Outcome({ thread }: { thread: ThreadSummary }) {
  const events = AsyncResult.getOrElse(
    useAtomValue(settledEventsAtom(thread.id as ThreadId)),
    () => undefined,
  );
  const stats =
    events === undefined || thread.lead === undefined
      ? undefined
      : runStats(events, thread.lead.id, thread.createdAt ?? thread.updatedAt);
  const took = stats?.took === undefined ? null : <span>{tookLabel(stats.took)}</span>;
  if (thread.status !== "idle") {
    return (
      <>
        <Status thread={thread} />
        {thread.status === "failed" ? took : null}
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
          <span className="text-success">+{stats.added}</span>{" "}
          <span className="text-error">−{stats.removed}</span>
        </span>
      )}
      {took}
    </>
  );
}
