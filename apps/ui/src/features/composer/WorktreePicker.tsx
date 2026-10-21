import { Select as BaseSelect } from "@base-ui/react/select";
import { FolderGit2, GitBranch, GitBranchPlus } from "lucide-react";

import { SelectItem, SelectPopup, SelectRoot, triggerClass } from "../../components/ui/Select.tsx";
import { FixedChip } from "./Pickers.tsx";

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
  const Icon = value ? GitBranchPlus : FolderGit2;
  return (
    <SelectRoot
      value={value ? "worktree" : "local"}
      onValueChange={(picked: string | null) => {
        if (picked !== null) onPick(picked === "worktree");
      }}
    >
      {/* The second step of the box's path (project / here), so it goes without a chevron like the first. */}
      <BaseSelect.Trigger aria-label="Where agents work" className={triggerClass}>
        <Icon size={13} strokeWidth={1.75} />
        {value ? "Worktree" : "Local"}
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

/** An open thread's own worktree: the branch its agents work on. */
export function WorktreeChip({ branch, base }: { readonly branch: string; readonly base: string }) {
  return (
    <FixedChip tip={`Works in a worktree of its own, made from ${base}`}>
      <GitBranch size={13} strokeWidth={1.75} />
      <span className="max-w-40 truncate">{branch}</span>
    </FixedChip>
  );
}
