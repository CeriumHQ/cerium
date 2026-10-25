import type { IssueSummary, LinkedPullRequest } from "@cerium/rpc";
import {
  CircleCheck,
  CircleDot,
  CircleSlash,
  CopyX,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";

import { stateLabel } from "./model.ts";

// The small pieces an issue is drawn from, in the list and in the viewer.

/** An issue's state as an icon: open is the one that gets a colour; closed ones are quiet. */
export function StateIcon({
  issue,
  size = 16,
  className = "",
}: {
  issue: Pick<IssueSummary, "state" | "stateReason">;
  size?: number;
  className?: string;
}) {
  const Icon =
    issue.state === "open"
      ? CircleDot
      : issue.stateReason === "notPlanned"
        ? CircleSlash
        : issue.stateReason === "duplicate"
          ? CopyX
          : CircleCheck;
  return (
    <span
      title={stateLabel(issue)}
      className={`shrink-0 ${issue.state === "open" ? "text-success" : "text-fg-tertiary"} ${className}`}
    >
      <Icon size={size} strokeWidth={1.75} aria-label={stateLabel(issue)} />
    </span>
  );
}

/** A pull request an issue links, by its number and how it stands. */
export function PullRequestChip({ pull }: { pull: LinkedPullRequest }) {
  const Icon =
    pull.state === "merged"
      ? GitMerge
      : pull.state === "closed"
        ? GitPullRequestClosed
        : pull.draft === true
          ? GitPullRequestDraft
          : GitPullRequest;
  const how = pull.state === "open" ? (pull.draft === true ? "draft" : "open") : pull.state;
  return (
    <span
      title={`${pull.title ?? "Pull request"} (${how})`}
      className="inline-flex shrink-0 items-center gap-1 text-meta text-fg-tertiary"
    >
      <Icon size={13} strokeWidth={1.75} className={pull.state === "open" ? "text-success" : ""} />
      <span className="tabular-nums">#{pull.number}</span>
    </span>
  );
}
