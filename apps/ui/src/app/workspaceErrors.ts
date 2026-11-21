import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import { exportFailureAtom } from "../features/export/useThreadExport.ts";

export const messageOf = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "Something went wrong. Try again.";

export function useWorkspaceErrors() {
  const [actionError, setActionError] = useState<string>();
  const exportFailure = useAtomValue(exportFailureAtom);
  const setExportFailure = useAtomSet(exportFailureAtom);
  const attempt = (action: Promise<unknown>): Promise<boolean> => {
    setActionError(undefined);
    return action.then(
      () => true,
      (error: unknown) => {
        setActionError(messageOf(error));
        return false;
      },
    );
  };

  const dismiss = () => {
    setActionError(undefined);
    setExportFailure(undefined);
  };

  return { attempt, setActionError, error: actionError ?? exportFailure, dismiss };
}
