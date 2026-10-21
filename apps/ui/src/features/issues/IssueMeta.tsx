import type { IssueDetail } from "@cerium/rpc";
import { GitBranch, UserMinus, UserPlus } from "lucide-react";
import type { ReactNode } from "react";

import { Avatar, GitHubLink, LabelChip } from "../github/parts.tsx";
import { LabelPicker } from "./LabelPicker.tsx";
import { PullRequestChip } from "./parts.tsx";
import type { IssueActions } from "./useIssueActions.ts";

const dueDate = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function Row({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5 max-md:flex-col max-md:gap-1">
      <div className="flex h-6 w-[5.5rem] shrink-0 items-center justify-between text-[12px] text-fg-tertiary max-md:w-auto max-md:gap-2">
        {title}
        {action}
      </div>
      <div className="flex min-h-6 min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-fg-secondary max-md:text-[14px]">
        {children}
      </div>
    </div>
  );
}

const None = ({ children }: { children: ReactNode }) => <span className="text-fg-tertiary">{children}</span>;

/**
 * What sets an issue apart from the conversation under it: its labels, who it is assigned to, its
 * milestone, and the pull requests and branches that work on it. Labels and assignees are editable
 * by anyone who may triage; the rest only shows.
 */
export function IssueMeta({
  cwd,
  issue,
  triage,
  me,
  actions,
  onOpenPull,
}: {
  cwd: string;
  issue: IssueDetail;
  /** The account may change labels and assignees. */
  triage: boolean;
  /** The signed-in account's login, once known. */
  me: string | undefined;
  actions: IssueActions;
  /** Opens a pull request of this repository in a tab; its chip is plain text without it. */
  onOpenPull: ((number: number) => void) | undefined;
}) {
  const busy = actions.busy !== undefined;
  const assignedToMe = me !== undefined && issue.assignees.some((user) => user.login === me);
  const milestone = issue.milestoneDetail;
  const shows =
    triage ||
    issue.labels.length > 0 ||
    issue.assignees.length > 0 ||
    issue.milestone !== undefined ||
    issue.pullRequests.length > 0 ||
    issue.branches.length > 0;
  if (!shows) return null;
  return (
    <div className="flex flex-col divide-y divide-line-subtle rounded-lg border border-line-subtle px-3 py-1">
      <Row
        title="Labels"
        action={
          triage ? (
            <LabelPicker
              cwd={cwd}
              chosen={new Set(issue.labels.map((label) => label.name))}
              busy={busy}
              onToggle={(label, on) =>
                void actions.update(on ? { addLabels: [label.name] } : { removeLabels: [label.name] })
              }
            />
          ) : undefined
        }
      >
        {issue.labels.length === 0 ? (
          <None>None yet</None>
        ) : (
          issue.labels.map((label) => <LabelChip key={label.name} label={label} />)
        )}
      </Row>
      <Row title="Assignees">
        {issue.assignees.length === 0 ? <None>No one</None> : null}
        {issue.assignees.map((user) => (
          <span key={user.login} className="inline-flex items-center gap-1.5">
            <Avatar user={user} size={18} />
            <span className="truncate">{user.login}</span>
          </span>
        ))}
        {!triage || me === undefined ? null : (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void actions.update(assignedToMe ? { removeAssignees: [me] } : { addAssignees: [me] })
            }
            className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg-secondary disabled:opacity-40 max-md:h-9 max-md:text-[13px]"
          >
            {assignedToMe ? (
              <UserMinus size={13} strokeWidth={1.75} />
            ) : (
              <UserPlus size={13} strokeWidth={1.75} />
            )}
            {assignedToMe ? "Unassign me" : "Assign me"}
          </button>
        )}
      </Row>
      {issue.milestone === undefined ? null : (
        <Row title="Milestone">
          {milestone?.url === undefined ? (
            <span>{issue.milestone}</span>
          ) : (
            <GitHubLink href={milestone.url}>{issue.milestone}</GitHubLink>
          )}
          {milestone?.dueOn === undefined ? null : (
            <span className="text-[12px] text-fg-tertiary">due {dueDate(milestone.dueOn)}</span>
          )}
        </Row>
      )}
      {issue.pullRequests.length === 0 ? null : (
        <Row title="Pull requests">
          {issue.pullRequests.map((pull) => {
            const chip = <PullRequestChip pull={pull} />;
            return (
              <span
                key={`${pull.repository ?? ""}#${pull.number}`}
                className="inline-flex min-w-0 items-center gap-1.5"
              >
                {pull.repository === undefined && onOpenPull !== undefined ? (
                  <button
                    type="button"
                    onClick={() => onOpenPull(pull.number)}
                    className="inline-flex items-center rounded-md px-0.5 hover:bg-surface-hover"
                  >
                    {chip}
                  </button>
                ) : (
                  <GitHubLink
                    href={pull.url}
                    className="inline-flex items-center rounded-md px-0.5 hover:bg-surface-hover"
                  >
                    {chip}
                  </GitHubLink>
                )}
                {pull.title === undefined ? null : (
                  <span className="truncate text-fg-secondary">{pull.title}</span>
                )}
              </span>
            );
          })}
        </Row>
      )}
      {issue.branches.length === 0 ? null : (
        <Row title="Branches">
          {issue.branches.map((branch) => (
            <span
              key={`${branch.repository ?? ""}:${branch.name}`}
              className="inline-flex min-w-0 items-center gap-1.5"
            >
              <GitBranch size={13} strokeWidth={1.75} className="shrink-0 text-fg-tertiary" />
              <span className="truncate font-mono text-[12px]">{branch.name}</span>
            </span>
          ))}
        </Row>
      )}
    </div>
  );
}
