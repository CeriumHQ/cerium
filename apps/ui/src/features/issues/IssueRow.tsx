import type { IssueSummary } from "@cerium/rpc";

import { shortAgo } from "../../lib/time.ts";
import { Avatar, CommentCount, ItemRow, loginOf } from "../github/parts.tsx";
import { PullRequestChip, StateIcon } from "./parts.tsx";

/** Assignees a row shows before it counts the rest. */
const ASSIGNEES_SHOWN = 3;

/**
 * An issue in the list, drawn as the pull requests beside it are: its state and title, who opened it
 * and when, then the pull requests that close it, how much has been said and who it's assigned to, and
 * its labels.
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
  const assignees = issue.assignees.slice(0, ASSIGNEES_SHOWN);
  return (
    <ItemRow
      icon={<StateIcon issue={issue} size={15} />}
      title={issue.title}
      facts={
        <>
          <span className="shrink-0 tabular-nums">#{issue.number}</span>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate">{loginOf(issue.author)}</span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0 tabular-nums">{shortAgo(issue.updatedAt, now)}</span>
        </>
      }
      marks={
        <>
          {issue.pullRequests.slice(0, 1).map((pull) => (
            <PullRequestChip key={`${pull.repository ?? ""}#${pull.number}`} pull={pull} />
          ))}
          <CommentCount count={issue.comments} />
          {assignees.length === 0 ? null : (
            <span
              className="flex -space-x-1"
              title={`Assigned to ${issue.assignees.map((user) => user.login).join(", ")}`}
            >
              {assignees.map((user) => (
                <span key={user.login} className="rounded-full ring-2 ring-surface-panel">
                  <Avatar user={user} size={16} />
                </span>
              ))}
            </span>
          )}
        </>
      }
      labels={issue.labels}
      current={active}
      onOpen={() => onOpen(issue.number, issue.title)}
    />
  );
}
