import { Fragment, useEffect, useState } from "react";

import { Notice } from "../../app/Notice.tsx";
import { shellBridge } from "../../backend/shell.ts";
import { CopyDetailsButton } from "./CrashViews.tsx";
import {
  asBackendFailure,
  backendFailureDetails,
  failureHeadline,
  shortMessage,
  type BackendFailure,
} from "./model.ts";

/** Why this computer's backend last stopped, kept current; undefined while it runs, and outside the desktop app. */
export function useBackendFailure(): BackendFailure | undefined {
  const [failure, setFailure] = useState<BackendFailure>();
  useEffect(() => {
    const bridge = shellBridge();
    let heard = false;
    const stop = bridge?.onBackendFailure?.((next) => {
      heard = true;
      setFailure(asBackendFailure(next));
    });
    void bridge?.backendFailure?.().then(
      (current) => {
        if (!heard) setFailure(asBackendFailure(current));
      },
      () => undefined,
    );
    return stop;
  }, []);
  return failure;
}

const linkClass =
  "inline font-medium text-fg-primary underline decoration-fg-tertiary underline-offset-2 hover:decoration-fg-primary";

/**
 * Says why the backend stopped instead of only that the window is reconnecting: what failed in one
 * line, a restart that skips the back-off, the logs folder, and the details to paste in a report.
 */
export function BackendFailureNotice({ failure }: { failure: BackendFailure }) {
  const bridge = shellBridge();
  const restart = bridge?.restartBackend;
  const openLogs = bridge?.openLogs;
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
