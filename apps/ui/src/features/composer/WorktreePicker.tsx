import { Select as BaseSelect } from "@base-ui/react/select";
import { FolderGit2, GitBranch, GitBranchPlus } from "lucide-react";

import { SelectItem, SelectPopup, SelectRoot } from "../../components/ui/Select.tsx";
import { chipClass } from "./Pickers.tsx";

/** The box's chip, free to shrink: on a narrow box the branch truncates first, before the project, rather than slide under the model. */
const branchChip = `${chipClass.replace("shrink-0 ", "")} min-w-8 shrink-[4] px-2`;

/**
 * Where a new work thread's agents work: in the project's own folder, beside every other thread
 * there, or in a git worktree of their own on a new branch made from `branch`.
 */
export function WorktreePicker({
  branch,
  value,
  onPick,
}: {
  /** The branch checked out in the project's folder. */
  readonly branch: string;
  readonly value: boolean;
  readonly onPick: (worktree: boolean) => void;
}) {
  const Icon = value ? GitBranchPlus : GitBranch;
  return (
    <SelectRoot
      value={value ? "worktree" : "local"}
      onValueChange={(picked: string | null) => {
        if (picked !== null) onPick(picked === "worktree");
      }}
    >
      {/* The second step of the box's path (project / branch), so it goes without a chevron like the first. */}
      <BaseSelect.Trigger aria-label="Where agents work" className={branchChip}>
        <Icon size={13} strokeWidth={1.75} className="shrink-0" />
        <span className="max-w-36 truncate">{value ? "New worktree" : branch}</span>
      </BaseSelect.Trigger>
      <SelectPopup>
        <SelectItem value="local" icon={FolderGit2} description={`In the project's folder, on ${branch}`}>
          Local
        </SelectItem>
        <SelectItem value="worktree" icon={GitBranchPlus} description={`A branch of its own, from ${branch}`}>
          New worktree
        </SelectItem>
      </SelectPopup>
    </SelectRoot>
  );
}
