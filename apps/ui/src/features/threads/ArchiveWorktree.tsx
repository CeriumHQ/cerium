import type { WorktreeChanges } from "@cerium/protocol";

import { ConfirmDialog } from "../../components/ui/ConfirmDialog.tsx";
import type { ThreadSummary } from "./model.ts";
import { archiveWarning } from "./worktree.ts";

/** Archiving removes a thread's worktree, so work its base doesn't have is confirmed first. */
export function ArchiveWorktreeDialog({
  thread,
  changes,
  open,
  onOpenChange,
  onConfirm,
}: {
  thread: ThreadSummary & { readonly worktree: NonNullable<ThreadSummary["worktree"]> };
  changes: WorktreeChanges;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { holds, outcome } = archiveWarning(changes, thread.worktree);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Archive with unmerged work?"
      description={
        <>
          {/* Quoted, so a title ending in punctuation doesn't run into the sentence. */}
          <span className="font-medium text-fg-primary">“{thread.title}”</span> has {holds}. {outcome}
        </>
      }
      confirmLabel="Archive"
      onConfirm={onConfirm}
    />
  );
}
