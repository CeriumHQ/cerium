import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { ReactNode } from "react";

import { Button, buttonClass } from "./Button.tsx";
import {
  dialogBackdropClass,
  dialogDescriptionClass,
  dialogPopupClass,
  dialogTitleClass,
} from "./FormDialog.tsx";

interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: ReactNode;
  readonly confirmLabel: string;
  readonly onConfirm: () => void;
}

/**
 * Asks before something that can't be undone. Controlled, so a menu item can open it; Esc, the
 * backdrop and Cancel all back out.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={dialogBackdropClass} />
        {/* Centred on the part of the page that shows (web/viewport.ts), and never taller than it. */}
        <AlertDialog.Popup className={`${dialogPopupClass("sm")} flex flex-col gap-4`}>
          <div className="flex flex-col gap-1.5">
            <AlertDialog.Title className={dialogTitleClass}>{title}</AlertDialog.Title>
            <AlertDialog.Description className={dialogDescriptionClass}>
              {description}
            </AlertDialog.Description>
          </div>
          <div className="flex justify-end gap-2">
            <AlertDialog.Close className={buttonClass()}>Cancel</AlertDialog.Close>
            <AlertDialog.Close render={<Button tone="danger" />} onClick={onConfirm}>
              {confirmLabel}
            </AlertDialog.Close>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
