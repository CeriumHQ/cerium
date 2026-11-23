import { Fragment, useEffect, useRef, useState } from "react";

import { Notice } from "../../app/Notice.tsx";
import { reconnectLocalNow } from "../../backend/client.ts";
import { shellBridge } from "../../backend/shell.ts";
import { CopyDetailsButton } from "./CrashViews.tsx";
import {
  asBackendFailure,
  backendFailureDetails,
  failureHeadline,
  isHostFailure,
  shortMessage,
  type BackendFailure,
} from "./model.ts";

/** Why this computer's backend last stopped, kept current; undefined while it runs, and outside the desktop app. */
export function useBackendFailure(): BackendFailure | undefined {
  const [failure, setFailure] = useState<BackendFailure>();
  const hadFailure = useRef(false);
  useEffect(() => {
    const bridge = shellBridge();
    let heard = false;
    const apply = (next: BackendFailure | undefined) => {
      const recovered = hadFailure.current && next === undefined;
      hadFailure.current = next !== undefined;
      setFailure(next);
      if (recovered) reconnectLocalNow();
    };
    const stop = bridge?.onBackendFailure?.((next) => {
      heard = true;
      apply(asBackendFailure(next));
    });
    void bridge?.backendFailure?.().then(
      (current) => {
        if (!heard) apply(asBackendFailure(current));
      },
      () => undefined,
    );
    return stop;
  }, []);
  return failure;
}

const linkClass =
  "inline font-medium text-fg-primary underline decoration-fg-tertiary underline-offset-2 hover:decoration-fg-primary disabled:opacity-50";

/**
 * Says why the backend stopped instead of only that the window is reconnecting: what failed in one
 * line, a restart that skips the back-off, the logs folder, and the details to paste in a report.
 */
export function BackendFailureNotice({ failure }: { failure: BackendFailure }) {
  const bridge = shellBridge();
  const restart = bridge?.restartBackend;
  const openLogs = bridge?.openLogs;

  if (isHostFailure(failure.kind)) {
    const host = failure.host;
    const busy = host?.busy;
    const actions = [
      failure.kind === "hostStopped" && host?.serviceInstalled && bridge?.startHostService ? (
        <button
          key="start-host"
          type="button"
          className={linkClass}
          disabled={busy !== undefined}
          onClick={() => void bridge.startHostService?.()}
        >
          {busy === "starting" ? "Starting…" : "Start Cerium Host"}
        </button>
      ) : null,
      failure.kind === "hostOutdated" && bridge?.updateHost ? (
        <button
          key="update-host"
          type="button"
          className={linkClass}
          disabled={busy !== undefined}
          onClick={() => void bridge.updateHost?.()}
        >
          {busy === "updating" ? "Updating…" : "Update Cerium Host"}
        </button>
      ) : null,
      failure.kind === "desktopOutdated" && bridge?.checkForUpdates ? (
        <button
          key="check-updates"
          type="button"
          className={linkClass}
          onClick={() => void bridge.checkForUpdates?.()}
        >
          Check for updates
        </button>
      ) : null,
      restart && busy === undefined ? (
        <button key="retry" type="button" className={linkClass} onClick={() => void restart()}>
          Retry
        </button>
      ) : null,
      host?.canFallback && bridge?.useLocalBackend && busy === undefined ? (
        <button
          key="fallback"
          type="button"
          className={linkClass}
          onClick={() => void bridge.useLocalBackend?.()}
        >
          Use local desktop
        </button>
      ) : null,
      failure.kind === "hostUnreachable" ? (
        <CopyDetailsButton
          key="copy"
          link={linkClass}
          text={backendFailureDetails(failure, bridge?.platform)}
        />
      ) : null,
    ].filter((action) => action !== null);

    return (
      <Notice tone={failure.kind === "hostUnreachable" ? "error" : "attention"}>
        <span className="text-fg-primary">{failureHeadline(failure.kind)}</span>{" "}
        <span>{shortMessage(failure.message, 220)}</span>{" "}
        {actions.length > 0 ? (
          <span className="whitespace-nowrap">
            {actions.map((action, index) => (
              <Fragment key={action.key}>
                {index > 0 ? <span className="text-fg-tertiary"> · </span> : null}
                {action}
              </Fragment>
            ))}
          </span>
        ) : null}
      </Notice>
    );
  }

  const actions = [
    restart ? (
      <button key="restart" type="button" className={linkClass} onClick={() => void restart()}>
        Restart
      </button>
    ) : null,
    openLogs ? (
      <button key="logs" type="button" className={linkClass} onClick={() => void openLogs()}>
        Logs
      </button>
    ) : null,
    <CopyDetailsButton key="copy" link={linkClass} text={backendFailureDetails(failure, bridge?.platform)} />,
  ].filter((action) => action !== null);
  return (
    <Notice tone="error">
      <span className="text-fg-primary">{failureHeadline(failure.kind)}</span>{" "}
      <span>{shortMessage(failure.message)}</span>{" "}
      <span className="whitespace-nowrap">
        {actions.map((action, index) => (
          <Fragment key={action.key}>
            {index > 0 ? <span className="text-fg-tertiary"> · </span> : null}
            {action}
          </Fragment>
        ))}
      </span>
    </Notice>
  );
}
