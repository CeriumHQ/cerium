import { Progress } from "@base-ui/react/progress";
import { useState } from "react";

import { Notice } from "../../app/Notice.tsx";
import { shellBridge } from "../../backend/shell.ts";
import { Reveal } from "../../components/Reveal.tsx";
import { noticeVersion, releaseNotesUrl, versionLabel } from "./model.ts";
import { useRestartToUpdate, useUpdates } from "./useUpdates.ts";

/** The version whose notice was dismissed, for as long as this window lives. */
let dismissedVersion: string | undefined;

const linkClass =
  "font-medium text-fg-primary underline decoration-fg-tertiary underline-offset-2 hover:decoration-fg-primary";

/**
 * Says so when the channel the user follows has a newer Cerium, from the check the shell runs at
 * launch (and every few hours after), and takes it to restart without opening settings: from the
 * download when updates wait to be started, from ready when they download by themselves. Dismissed,
 * it stays away until a newer version turns up, or until Cerium restarts for it.
 */
export function UpdateNotice() {
  const updates = useUpdates();
  const [dismissed, setDismissed] = useState(dismissedVersion);
  const { confirming, restart, cancel } = useRestartToUpdate();
  const version = updates && noticeVersion(updates);
  const installing = updates?.status.kind === "installing";
  // It drops in under the titlebar, and folds back up once dismissed.
  if (updates === undefined || version === undefined || (version === dismissed && !installing)) {
    return (
      <Reveal shift={-6} className="shrink-0">
        {null}
      </Reveal>
    );
  }

  const bridge = shellBridge();
  const dismiss = () => {
    dismissedVersion = version;
    setDismissed(version);
  };
  const { status } = updates;

  return (
    <Reveal shift={-6} className="shrink-0">
      <Notice
        tone={status.kind === "failed" ? "error" : "update"}
        onDismiss={installing ? undefined : dismiss}
      >
        {status.kind === "installing" ? (
          <>Restarting to install {versionLabel(version)}…</>
        ) : status.kind === "ready" && confirming ? (
          <>
            Restarting stops the agents that are working.{" "}
            <button type="button" onClick={() => restart(true)} className={linkClass}>
              Restart anyway
            </button>
            <span className="text-fg-tertiary"> · </span>
            <button type="button" onClick={cancel} className={linkClass}>
              Not now
            </button>
          </>
        ) : status.kind === "available" ? (
          <>
            {versionLabel(version)} is available.{" "}
            <button type="button" onClick={() => void bridge?.downloadUpdate?.()} className={linkClass}>
              {updates.manual ? "Download" : "Update"}
            </button>
            <span className="text-fg-tertiary"> · </span>
            <a href={releaseNotesUrl(version)} target="_blank" rel="noreferrer" className={linkClass}>
              What's new
            </a>
          </>
        ) : status.kind === "downloading" ? (
          <span className="flex items-center gap-3">
            <span className="shrink-0">Downloading {versionLabel(version)}…</span>
            <Progress.Root
              value={Math.floor(status.percent)}
              aria-label={`Downloading ${versionLabel(version)}`}
            >
              <Progress.Track className="h-1 w-24 overflow-hidden rounded-full bg-line-strong">
                <Progress.Indicator className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out-soft" />
              </Progress.Track>
            </Progress.Root>
            <span className="text-fg-tertiary tabular-nums">{Math.floor(status.percent)}%</span>
          </span>
        ) : status.kind === "ready" ? (
          <>
            {versionLabel(version)} is ready.{" "}
            <button type="button" onClick={() => restart()} className={linkClass}>
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
    </Reveal>
  );
}
