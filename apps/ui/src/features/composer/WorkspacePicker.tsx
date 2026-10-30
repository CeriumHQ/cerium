import { Popover } from "@base-ui/react/popover";
import type { WorkspaceChoice } from "@cerium/protocol";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { GitBranch, GitBranchPlus } from "lucide-react";
import { useState } from "react";

import { checkoutsAtom } from "../../backend/projects.ts";
import { CheckoutChooser } from "../git/CheckoutChooser.tsx";
import { samePath, worktreeLabel } from "../git/workspace.ts";
import { chipClass } from "./Pickers.tsx";

/** The box's chip, free to shrink: on a narrow box the branch truncates first, before the project, rather than slide under the model. */
const branchChip = `${chipClass.replace("shrink-0 ", "")} min-w-8 shrink-[4] px-2 data-popup-open:bg-surface-active data-popup-open:text-fg-primary`;

/**
 * Where a new work thread's agents work: the project's own folder, a checkout another thread already
 * works in, or a new worktree, made from a branch, a thread's work, a pull request or a branch of its own.
 */
export function WorkspacePicker({
  branch,
  root,
  value,
  workspace,
  onPick,
}: {
  /** The branch checked out in the project's folder. */
  readonly branch: string;
  /** The project's folder. */
  readonly root: string;
  /** A new worktree is picked. */
  readonly value: boolean;
  readonly workspace?: WorkspaceChoice | undefined;
  readonly onPick: (worktree: boolean, workspace?: WorkspaceChoice) => void;
}) {
  const [open, setOpen] = useState(false);
  const refresh = useAtomRefresh(checkoutsAtom(root));
  const checkouts = AsyncResult.getOrElse(useAtomValue(checkoutsAtom(root)), () => []);
  const path = workspace?.path;
  const picked = path === undefined ? undefined : checkouts.find((checkout) => samePath(checkout.path, path));
  const Icon = value ? GitBranchPlus : GitBranch;
  const label = value ? worktreeLabel(workspace) : (picked?.branch ?? branch);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) refresh();
      }}
    >
      {/* The second step of the box's path (project / branch), so it goes without a chevron like the first. */}
      <Popover.Trigger aria-label="Where agents work" className={branchChip}>
        <Icon size={13} strokeWidth={1.75} className="shrink-0" />
        <span className="max-w-36 truncate">{label}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={6} className="z-50 outline-none">
          <Popover.Popup className="flex max-h-[min(var(--available-height),26rem)] w-[22rem] max-w-[calc(100vw-1.5rem)] origin-(--transform-origin) flex-col overflow-hidden rounded-xl border border-line-subtle bg-surface-overlay text-fg-primary shadow-overlay backdrop-blur-2xl transition-[opacity,scale] duration-150 ease-out-soft outline-none data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0">
            <CheckoutChooser
              root={root}
              branch={branch}
              local={{ selected: !value && path === undefined }}
              except={[root]}
              selectedPath={value ? undefined : path}
              worktree={{ selected: value, choice: value ? workspace : undefined }}
              confirmLabel="Use this worktree"
              onPick={(pick) => {
                onPick(pick.worktree, pick.workspace);
                setOpen(false);
              }}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
