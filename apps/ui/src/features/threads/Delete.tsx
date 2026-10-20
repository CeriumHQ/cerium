import { ConfirmDialog } from "../../components/ui/ConfirmDialog.tsx";
import type { ThreadSummary } from "./model.ts";

/** Deleting can't be undone, so it is confirmed first. */
export function DeleteThreadDialog({
  thread,
  open,
  onOpenChange,
  onConfirm,
}: {
  thread: ThreadSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const noun = thread.mode === "work" ? "thread" : "chat";
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete this ${noun}?`}
      description={
        <>
          {/* Quoted, so a title ending in punctuation doesn't run into the sentence. */}
          <span className="font-medium text-fg-primary">“{thread.title}”</span> and every message in it will
          be deleted for good
          {thread.worktree && thread.archivedAt === undefined
            ? `, with its worktree and what isn't committed there; commits stay on ${thread.worktree.branch}`
            : ""}
          . This can't be undone.
        </>
      }
      confirmLabel="Delete"
      onConfirm={onConfirm}
    />
  );
}
