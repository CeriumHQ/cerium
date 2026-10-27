import {
  childProcessIntegration,
  dedupeIntegration,
  electronContextIntegration,
  init,
  IPCMode,
  linkedErrorsIntegration,
  normalizePathsIntegration,
  onUncaughtExceptionIntegration,
  onUnhandledRejectionIntegration,
  withScope,
  captureException,
  type ErrorEvent,
} from "@sentry/electron/main";
import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";

import { errorOf, fingerprintOf, limitKeyOf, reportLimiter, type CrashReport } from "./crashReport.ts";
import { scrubEvent } from "./scrub.ts";

// Anonymous crash reports, to Sentry: the failures of the shell itself, and those the UI and the
// backend hand it (crashReport.ts), which is the only process that sends any. Only a packaged build
// given a DSN when it was built sends reports, and only while Settings → General → Send crash reports
// is on (the default). What a report may hold is scrub.ts's to decide; nothing else is collected:
// no native crash dumps, screenshots, breadcrumbs, local variables, sessions or performance data.

/** Set by the release workflows when they build the shell (vite.config.ts); absent anywhere else. */
declare const __CERIUM_SENTRY_DSN__: string | undefined;

const DSN = typeof __CERIUM_SENTRY_DSN__ === "string" ? __CERIUM_SENTRY_DSN__ : "";
/** Where the user's choice is kept, only once they turned reports off or back on. */
const SETTING_FILE = "crash-reports.json";

export interface CrashReportsState {
  /** This build can send reports: it's packaged and was built with a DSN. */
  readonly available: boolean;
  readonly enabled: boolean;
}

let enabled = true;
let started = false;
const allowed = reportLimiter();
const settingFile = () => join(app.getPath("userData"), SETTING_FILE);

const readEnabled = (): boolean => {
  try {
    const saved = JSON.parse(readFileSync(settingFile(), "utf8")) as { enabled?: unknown };
    return saved.enabled !== false;
  } catch {
    return true;
  }
};

const available = () => DSN !== "" && app.isPackaged;

/** The system's name as Sentry groups by it. */
const systemName = () =>
  process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";

/**
 * The last say on every event: none while reports are off, or when the same failure was just sent.
 * `reportCrash` limits its own reports, which carry a category; this limits what Sentry caught itself.
 */
const beforeSend = (event: ErrorEvent): ErrorEvent | null => {
  if (!enabled) return null;
  if (event.tags?.["category"] === undefined) {
    const exception = event.exception?.values?.[0];
    const key = `auto|${exception?.type ?? ""}|${(exception?.value ?? event.message ?? "").slice(0, 80)}`;
    if (!allowed(key, Date.now())) return null;
  }
  return scrubEvent(event);
};

const start = (channel: string) => {
  if (started || !available()) return;
  started = true;
  init({
    dsn: DSN,
    release: `cerium@${app.getVersion()}`,
    environment: channel,
    // Renderers report through the preload bridge, never Sentry's own channel, so no protocol of its own.
    ipcMode: IPCMode.Classic,
    // No user, IP address, headers, cookies or bodies, whatever an integration would collect.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    sendClientReports: false,
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    beforeSendTransaction: () => null,
    beforeSend,
    // Only what a crash report needs: the system and versions, crashed child processes, and errors
    // nothing caught. The defaults would add native dumps, screenshots, breadcrumbs of windows (whose
    // titles are threads'), network requests and local variables.
    defaultIntegrations: false,
    integrations: [
      electronContextIntegration(),
      childProcessIntegration({
        breadcrumbs: false,
        events: ["crashed", "oom", "launch-failed", "integrity-failure"],
      }),
      onUncaughtExceptionIntegration(),
      onUnhandledRejectionIntegration(),
      linkedErrorsIntegration(),
      dedupeIntegration(),
      normalizePathsIntegration(),
    ],
    // The system and processor, without the Node integration's host name, memory and boot time.
    initialScope: {
      tags: { process: "main", channel },
      contexts: { os: { name: systemName(), version: release() }, device: { arch: process.arch } },
    },
  });
};

/** Starts reporting, unless the user turned it off; call before the app is ready. */
export const startCrashReports = (channel: string) => {
  enabled = readEnabled();
  if (enabled) start(channel);
  return {
    state: (): CrashReportsState => ({ available: available(), enabled }),
    setEnabled: (next: boolean): CrashReportsState => {
      enabled = next;
      try {
        writeFileSync(settingFile(), JSON.stringify({ enabled: next }));
      } catch {
        // Kept for this run only; the next starts with reports on again.
      }
      if (next) start(channel);
      return { available: available(), enabled };
    },
  };
};

/** Sends a failure one of Cerium's processes reported, as reports allow. */
export const reportCrash = (report: CrashReport) => {
  if (!started || !enabled || !allowed(`report|${limitKeyOf(report)}`, Date.now())) return;
  withScope((scope) => {
    scope.setTags({
      process: report.process,
      category: report.category,
      ...(report.kind === undefined ? {} : { kind: report.kind }),
      ...(typeof report.context?.["harness"] === "string" ? { harness: report.context["harness"] } : {}),
    });
    if (report.context !== undefined) scope.setContext("cerium", report.context);
    scope.setFingerprint(fingerprintOf(report));
    captureException(errorOf(report), { mechanism: { type: `cerium.${report.category}`, handled: true } });
  });
};
