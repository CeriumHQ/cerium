import type { IssueSummary } from "@cerium/rpc";
import { MessageSquare } from "lucide-react";

import { shortAgo } from "../../lib/time.ts";
import { Avatar, LabelChip } from "../github/parts.tsx";
import { PullRequestChip, StateIcon } from "./parts.tsx";

/** Labels a row shows before it counts the rest. */
const LABELS_SHOWN = 3;
/** Assignees a row shows before it counts the rest. */
const ASSIGNEES_SHOWN = 3;

/**
 * An issue in the list: its state and title, who opened it and when, the pull requests that close
 * it, its labels, and on the right how much has been said and who it is assigned to.
 */
export function IssueRow({
  issue,
  now,
  active,
  onOpen,
}: {
  issue: IssueSummary;
  now: number;
  /** The viewer shows this issue. */
  active: boolean;
  onOpen: (number: number, title: string) => void;
}) {
  const hiddenLabels = issue.labels.length - LABELS_SHOWN;
  const assignees = issue.assignees.slice(0, ASSIGNEES_SHOWN);
  return (
    <button
      type="button"
      onClick={() => onOpen(issue.number, issue.title)}
      onAuxClick={(event) => {
        if (event.button === 1) onOpen(issue.number, issue.title);
      }}
      aria-current={active ? "page" : undefined}
      className="flex w-full items-start gap-2.5 border-b border-line-subtle px-3 py-2.5 text-left outline-none transition-colors select-none hover:bg-surface-hover focus-visible:ring-1 focus-visible:ring-focus-ring focus-visible:ring-inset aria-[current=page]:bg-surface-selected max-md:py-3"
    >
      <StateIcon issue={issue} className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="line-clamp-2 text-[13px] leading-snug text-fg-primary max-md:text-[15px]">
          {issue.title}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg-tertiary">
          <span className="shrink-0 tabular-nums">#{issue.number}</span>
          {issue.author === undefined ? null : (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{issue.author.login}</span>
            </>
          )}
          <span aria-hidden>·</span>
          <span className="shrink-0">{shortAgo(issue.updatedAt, now)}</span>
          {issue.pullRequests.slice(0, 2).map((pull) => (
            <PullRequestChip key={`${pull.repository ?? ""}#${pull.number}`} pull={pull} />
          ))}
        </span>
        {issue.labels.length === 0 ? null : (
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {issue.labels.slice(0, LABELS_SHOWN).map((label) => (
              <LabelChip key={label.name} label={label} />
            ))}
            {hiddenLabels > 0 ? (
              <span className="text-[11.5px] text-fg-tertiary">+{hiddenLabels}</span>
            ) : null}
          </span>
        )}
      </span>
      {issue.comments === 0 && assignees.length === 0 ? null : (
        <span className="flex shrink-0 flex-col items-end gap-1.5 pt-0.5 text-[12px] text-fg-tertiary">
          {issue.comments === 0 ? null : (
            <span className="inline-flex items-center gap-1" title={`${issue.comments} comments`}>
              <MessageSquare size={12} strokeWidth={1.75} />
              <span className="tabular-nums">{issue.comments}</span>
            </span>
          )}
          {assignees.length === 0 ? null : (
            <span
              className="flex -space-x-1.5"
              title={`Assigned to ${issue.assignees.map((user) => user.login).join(", ")}`}
            >
              {assignees.map((user) => (
                <span key={user.login} className="rounded-full ring-2 ring-surface-panel">
                  <Avatar user={user} size={18} />
                </span>
              ))}
            </span>
          )}
        </span>
      )}
    </button>
  );
}
