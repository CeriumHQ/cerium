import { shellBridge, type UiCrashReport } from "../../backend/shell.ts";

// The UI's failures, handed to the desktop shell for its anonymous crash reports
// (apps/desktop/src/crashReports.ts), which scrubs them and sends them as the user allows. Only the
// error goes: its name, message and stack. Outside the desktop app nothing is reported.

/** Errors browsers raise for nothing that went wrong. */
const BENIGN = [/^ResizeObserver loop/, /^Script error\.?$/];

/** The report for `error`, unless it is one of the benign ones. */
export const uiCrashReport = (
  category: UiCrashReport["category"],
  error: unknown,
  kind?: string,
): UiCrashReport | undefined => {
  const failure = error instanceof Error ? error : undefined;
  const message = failure?.message ?? (typeof error === "string" ? error : "");
  if (BENIGN.some((pattern) => pattern.test(message))) return undefined;
  return {
    category,
    name: failure?.name ?? "Error",
    message,
    ...(failure?.stack === undefined ? {} : { stack: failure.stack }),
    ...(kind === undefined ? {} : { kind }),
  };
};

const send = (report: UiCrashReport | undefined) => {
  if (report !== undefined) shellBridge()?.reportCrash?.(report);
};

/**
 * React's reports of what threw while drawing: caught by a crash guard (a pane's, or the window's
 * when `window` says so) or by nothing. They still go to the console, as React's own would.
 */
export const renderErrorHandlers = (isWindowGuard: (boundary: unknown) => boolean) => ({
  onCaughtError: (error: unknown, info: { readonly errorBoundary?: unknown }) => {
    console.error(error);
    send(uiCrashReport("render", error, isWindowGuard(info.errorBoundary) ? "window" : "pane"));
  },
  onUncaughtError: (error: unknown) => {
    console.error(error);
    send(uiCrashReport("render", error, "uncaught"));
  },
});

/** Reports errors and rejections nothing in the page handled. */
export const reportUnhandled = () => {
  window.addEventListener("error", (event) =>
    send(uiCrashReport("uncaught", event.error ?? event.message, "error")),
  );
  window.addEventListener("unhandledrejection", (event) =>
    send(uiCrashReport("uncaught", event.reason, "rejection")),
  );
};
