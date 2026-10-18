import { useState } from "react";

import { Notice } from "../../app/Notice.tsx";
import { shellBridge } from "../../backend/shell.ts";
import { noticeVersion, versionLabel } from "./model.ts";
import { useUpdates } from "./useUpdates.ts";

/** The version whose notice was dismissed, for as long as this window lives. */
let dismissedVersion: string | undefined;

const linkClass =
  "font-medium text-fg-primary underline decoration-fg-tertiary underline-offset-2 hover:decoration-fg-primary";

/**
 * Says so when the channel the user follows has a newer Cerium, from the check the shell runs at
 * launch (and every few hours after), and takes it from download to restart without opening
 * settings. Dismissed, it stays away until a newer version turns up.
 */
export function UpdateNotice({ onOpenSettings }: { onOpenSettings: () => void }) {
  const updates = useUpdates();
  const [dismissed, setDismissed] = useState(dismissedVersion);
  const version = updates && noticeVersion(updates.status);
  if (updates === undefined || version === undefined || version === dismissed) return null;

  const bridge = shellBridge();
  const dismiss = () => {
    dismissedVersion = version;
    setDismissed(version);
  };
  const { status } = updates;

  return (
    <Notice tone={status.kind === "failed" ? "error" : "update"} onDismiss={dismiss}>
      {status.kind === "available" ? (
        <>
          {versionLabel(version)} is available.{" "}
          <button type="button" onClick={() => void bridge?.downloadUpdate?.()} className={linkClass}>
            Update
          </button>
          <span className="text-fg-tertiary"> · </span>
          <button type="button" onClick={onOpenSettings} className={linkClass}>
            Details
          </button>
        </>
      ) : status.kind === "downloading" ? (
        <span className="tabular-nums">
          Downloading {versionLabel(version)}… {Math.floor(status.percent)}%
        </span>
      ) : status.kind === "ready" ? (
        <>
          {versionLabel(version)} is ready.{" "}
          <button type="button" onClick={() => void bridge?.installUpdate?.()} className={linkClass}>
            Restart to update
          </button>
        </>
      ) : (
        <>
          Couldn't download {versionLabel(version)}.{" "}
          <button type="button" onClick={() => void bridge?.downloadUpdate?.()} className={linkClass}>
            Try again
          </button>
        </>
      )}
    </Notice>
  );
}
