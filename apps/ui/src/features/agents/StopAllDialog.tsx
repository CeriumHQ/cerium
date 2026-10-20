import { ConfirmDialog } from "../../components/ui/ConfirmDialog.tsx";
import { stopAllSummary } from "./model.ts";

/** Stopping the whole thread at once is confirmed with what it would end. */
export function StopAllDialog({
  scope,
  open,
  onOpenChange,
  onConfirm,
}: {
  scope: { readonly agents: number; readonly approvals: number };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Stop everything?"
      description={
        <>
          This ends <span className="font-medium text-fg-primary">{stopAllSummary(scope)}</span>
          {scope.approvals > 0 ? ", denying each approval" : ""}. The thread stays open for your next message.
        </>
      }
      confirmLabel="Stop everything"
      onConfirm={onConfirm}
    />
  );
}
