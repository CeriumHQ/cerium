import type { CommitRef } from "@cerium/rpc";
import { Cloud, GitBranch, Tag, type LucideIcon } from "lucide-react";

const refIcon: Readonly<Record<CommitRef["kind"], LucideIcon>> = {
  branch: GitBranch,
  tag: Tag,
  upstream: Cloud,
};

const refWord: Readonly<Record<CommitRef["kind"], string>> = {
  branch: "Branch",
  tag: "Tag",
  upstream: "Remote branch",
};

/**
 * A branch, tag or remote branch a commit carries, told apart by its icon; the checked-out branch is
 * the one drawn bright. A long name is cut short.
 */
export function RefChip({ marker }: { marker: CommitRef }) {
  const Icon = refIcon[marker.kind];
  const label = `${refWord[marker.kind]} ${marker.name}${marker.current === true ? ", checked out" : ""}`;
  return (
    <span
      title={label}
      aria-label={label}
      className={`inline-flex h-[18px] max-w-36 min-w-0 shrink items-center gap-1 rounded-full border px-1.5 text-caption leading-none ${
        marker.current === true ? "border-line-strong text-fg-primary" : "border-line-subtle text-fg-tertiary"
      }`}
    >
      <Icon size={10} strokeWidth={2} className="shrink-0" aria-hidden="true" />
      <span className="truncate">{marker.name}</span>
    </span>
  );
}
