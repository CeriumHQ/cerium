import { app, BrowserWindow, shell } from "electron";
import electronUpdater, { type BaseUpdater } from "electron-updater";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { reportCrash } from "./crashReports.ts";
import { linuxInstall } from "./linuxInstall.ts";
import { diskImageUrl, updatesInPlace } from "./macUpdates.ts";

// Updating Cerium from within. The installed app follows one release
// channel's GitHub Releases through electron-updater: stable's latest release, or the newest
// nightly. The UI shows what this module reports and asks it to check, download and install. An
// update a check finds downloads at once unless the user turned that off, so restarting is all it
// waits for. It checks at launch and every few hours, so a window that lives in the tray still hears
// of updates. When the releases can't be reached (offline, or not published where the app can read
// them) it says so and offers nothing to install.
//
// On Windows the update installs once Cerium has stopped, the backend included, so the installer
// neither waits for its processes nor kills them, and it runs with its window: a progress page that
// says Cerium is updating and closes by itself (build/installer.nsh), whether Cerium quit or
// restarted for it.

const { autoUpdater } = electronUpdater;

export type UpdateChannel = "stable" | "nightly";

export type UpdateStatus =
  /** A development build: only the installed app updates. */
  | { readonly kind: "unsupported" }
  | { readonly kind: "checking" }
  | { readonly kind: "current"; readonly checkedAt: number }
  | { readonly kind: "available"; readonly version: string }
  | { readonly kind: "downloading"; readonly version: string; readonly percent: number }
  | { readonly kind: "ready"; readonly version: string }
  /** Cerium is closing to restart into the downloaded update. */
  | { readonly kind: "installing"; readonly version: string }
  /** The releases couldn't be read: `offline`, or `unpublished` when the channel has none to read. */
  | { readonly kind: "unreachable"; readonly reason: "offline" | "unpublished"; readonly checkedAt: number }
  | { readonly kind: "failed"; readonly version: string };

export interface Updates {
  readonly channel: UpdateChannel;
  /** The running build's version and channel. */
  readonly version: string;
  readonly buildChannel: UpdateChannel;
  readonly status: UpdateStatus;
  /**
   * This build can't install updates itself (a Mac build signed ad hoc, macUpdates.ts): downloading
   * one opens its disk image in the browser.
   */
  readonly manual: boolean;
  /** An update downloads as soon as a check finds it; off, each waits for the user to start it. */
  readonly autoDownload: boolean;
}

/** What asking to restart into the update did: `working` when agents would stop and it wasn't forced. */
export type InstallResult = "started" | "working" | "unavailable";

export const isUpdateChannel = (value: unknown): value is UpdateChannel =>
  value === "stable" || value === "nightly";

/** Nightlies carry `-nightly.n<run>` in their version (scripts/release.ts). */
export const buildChannel = (): UpdateChannel =>
  app.getVersion().includes("-nightly.") ? "nightly" : "stable";

/** How often a running Cerium looks again. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** The launch check waits for the window, so it isn't competing with the backend's start. */
const LAUNCH_CHECK_DELAY_MS = 10_000;

/**
 * Not-found answers mean there is nothing this app can read: the releases aren't public, or the
 * channel's newest release carries no update file. Anything else is the network.
 */
const unpublishedCodes = new Set([
  "ERR_UPDATER_NO_PUBLISHED_VERSIONS",
  "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
  "ERR_UPDATER_LATEST_VERSION_NOT_FOUND",
]);
const reasonFor = (error: unknown): "offline" | "unpublished" => {
  const { code, statusCode } = (error ?? {}) as { code?: unknown; statusCode?: unknown };
  return statusCode === 404 || (typeof code === "string" && unpublishedCodes.has(code))
    ? "unpublished"
    : "offline";
};

/** Whether an update failed for want of a network, which no report would help with. */
export const offline = (error: unknown): boolean => {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  const text = `${typeof code === "string" ? code : ""} ${typeof message === "string" ? message : ""}`;
  return /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|net::ERR_(INTERNET_DISCONNECTED|NETWORK|NAME_NOT_RESOLVED|CONNECTION|TIMED_OUT|ADDRESS_UNREACHABLE|PROXY)/.test(
    text,
  );
};

/** Reports an update that failed for a reason of its own, with electron-updater's code. */
const reportUpdateFailure = (phase: "check" | "download", error: unknown) => {
  const { code, name, message, stack } = (error ?? {}) as Partial<
    Record<"code" | "name" | "message" | "stack", unknown>
  >;
  reportCrash({
    process: "main",
    category: "update",
    kind: phase,
    name: typeof name === "string" ? name : "UpdateError",
    message: typeof message === "string" ? message : String(error),
    ...(typeof stack === "string" ? { stack } : {}),
    context: { phase, ...(typeof code === "string" ? { code } : {}) },
  });
};

const windows = process.platform === "win32";

/** What the updater needs from the rest of the shell (main.ts). */
export interface UpdaterHost {
  /** Whether agents are working on this computer, which restarting would stop. */
  readonly working: () => boolean;
  /** Stops the backend, its finalizers run; quitting waits for the same stop. */
  readonly stopBackend: () => Promise<void>;
}

export const startUpdater = (host: UpdaterHost) => {
  const preferenceFile = join(app.getPath("userData"), "update-channel");
  /** Holds `manual` once the user turned automatic downloads off. */
  const downloadPreferenceFile = join(app.getPath("userData"), "update-download");
  const logFile = join(app.getPath("logs"), "updater.log");
  mkdirSync(app.getPath("logs"), { recursive: true });
  const log =
    (level: string) =>
    (message: unknown): void => {
      try {
        appendFileSync(logFile, `${new Date().toISOString()} ${level} ${String(message)}\n`);
      } catch {
        // A log that can't be written isn't worth failing an update over.
      }
    };

  const readChannel = (): UpdateChannel => {
    try {
      const saved = readFileSync(preferenceFile, "utf8").trim();
      if (isUpdateChannel(saved)) return saved;
    } catch {
      // Never chosen: follow the channel this build came from.
    }
    return buildChannel();
  };

  let channel = readChannel();
  let autoDownload = (() => {
    try {
      return readFileSync(downloadPreferenceFile, "utf8").trim() !== "manual";
    } catch {
      return true;
    }
  })();
  // On Linux, an AppImage updates by electron-updater swapping the file its runtime names in APPIMAGE,
  // and a .deb or .rpm by installing the next package with the system's package manager, which asks
  // for the user's password (linuxInstall.ts). Anything else, a build run from a folder, doesn't.
  const updatable = app.isPackaged && (process.platform !== "linux" || linuxInstall() !== undefined);
  let status: UpdateStatus = updatable ? { kind: "checking" } : { kind: "unsupported" };
  // A Mac build counts as manual until codesign says otherwise, well before the first check.
  let manual = process.platform === "darwin";
  if (updatable && manual) {
    void updatesInPlace().then((inPlace) => {
      manual = !inPlace;
      set(status);
    });
  }

  const snapshot = (): Updates => ({
    channel,
    version: app.getVersion(),
    buildChannel: buildChannel(),
    status,
    manual,
    autoDownload,
  });
  const set = (next: UpdateStatus) => {
    status = next;
    const updates = snapshot();
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("cerium:updates", updates);
  };

  autoUpdater.logger = { info: log("info"), warn: log("warn"), error: log("error"), debug: () => undefined };
  // Downloads start here, so the status knows who started each.
  autoUpdater.autoDownload = false;
  // A downloaded update the user didn't restart for installs as Cerium quits: on Windows from
  // installOnExit, once the backend has stopped, and elsewhere through electron-updater's own handler.
  autoUpdater.autoInstallOnAppQuit = !windows;
  // electron-updater emits each failure before rethrowing it, and an emitter nobody listens to throws
  // it instead. An install that couldn't start (the package manager's password prompt declined, say)
  // leaves the update waiting for a restart again.
  autoUpdater.on("error", () => {
    if (status.kind === "installing") set({ kind: "ready", version: status.version });
  });

  /** Points electron-updater at the channel's feed. */
  const follow = (next: UpdateChannel) => {
    // Stable reads the repository's latest release and its latest.yml; nightly the newest
    // prerelease tagged `-nightly.` and its nightly.yml.
    autoUpdater.allowPrerelease = next === "nightly";
    autoUpdater.channel = next === "nightly" ? "nightly" : "latest";
    // Setting the channel allows downgrades. A newer build's database migrations can't be undone, so
    // a nightly that moves to stable waits until stable passes it.
    autoUpdater.allowDowngrade = false;
  };
  follow(channel);

  /** Downloading, downloaded or installing: that build is what there is to offer until it installs. */
  const settled = () =>
    status.kind === "downloading" || status.kind === "ready" || status.kind === "installing";

  let checking: Promise<void> | undefined;
  const check = (): Promise<void> => {
    if (!updatable || settled()) return Promise.resolve();
    if (checking !== undefined) return checking;
    set({ kind: "checking" });
    checking = autoUpdater
      .checkForUpdates()
      .then(
        (result) => {
          if (result?.isUpdateAvailable !== true) return set({ kind: "current", checkedAt: Date.now() });
          set({ kind: "available", version: result.updateInfo.version });
          if (autoDownload && !manual) void download("background");
        },
        (error: unknown) => {
          if (!offline(error)) reportUpdateFailure("check", error);
          set({ kind: "unreachable", reason: reasonFor(error), checkedAt: Date.now() });
        },
      )
      .finally(() => {
        checking = undefined;
      });
    return checking;
  };

  autoUpdater.on("download-progress", (progress: { percent: number }) => {
    if (status.kind === "downloading") set({ ...status, percent: progress.percent });
  });

  /**
   * Downloads the update a check found. One the user started fails visibly; one that started by
   * itself and lost the network goes back to waiting, and the next check starts it again.
   */
  const download = async (origin: "user" | "background" = "user"): Promise<void> => {
    if (status.kind !== "available" && status.kind !== "failed") return;
    const { version } = status;
    if (manual) {
      await shell.openExternal(diskImageUrl(version));
      return;
    }
    set({ kind: "downloading", version, percent: 0 });
    try {
      await autoUpdater.downloadUpdate();
      set({ kind: "ready", version });
    } catch (error) {
      log("error")(error);
      const lostNetwork = offline(error);
      if (!lostNetwork) reportUpdateFailure("download", error);
      set(
        origin === "background" && lostNetwork ? { kind: "available", version } : { kind: "failed", version },
      );
    }
  };

  if (updatable) {
    setTimeout(() => void check(), LAUNCH_CHECK_DELAY_MS);
    setInterval(() => void check(), CHECK_INTERVAL_MS);
  }

  return {
    updates: snapshot,
    check: async (): Promise<Updates> => {
      await check();
      return snapshot();
    },
    /** Saves the user's channel and looks for its newest build. */
    setChannel: async (next: UpdateChannel): Promise<Updates> => {
      if (next !== channel && !settled()) {
        channel = next;
        writeFileSync(preferenceFile, next);
        follow(next);
        await check();
      }
      return snapshot();
    },
    /** Saves whether updates download by themselves, and starts one that is waiting when turned on. */
    setAutoDownload: (on: boolean): Updates => {
      autoDownload = on;
      writeFileSync(downloadPreferenceFile, on ? "auto" : "manual");
      set(status);
      if (on && !manual && status.kind === "available") void download("background");
      return snapshot();
    },
    download: () => download("user"),
    /**
     * Restarts into the downloaded update, unless agents are working and the user hasn't said to
     * stop them. On Windows Cerium stops first, its window saying so, and the installer runs once it
     * has (installOnExit). On macOS electron-updater puts the new app in the old one's place, and on
     * Linux the new AppImage or package; then the new build starts.
     */
    install: (anyway: boolean): InstallResult => {
      if (status.kind !== "ready") return "unavailable";
      if (!anyway && host.working()) return "working";
      set({ kind: "installing", version: status.version });
      if (windows) void host.stopBackend().then(() => app.quit());
      else autoUpdater.quitAndInstall(true, true);
      return "started";
    },
    /**
     * Runs the downloaded update's installer as Cerium exits on Windows, once the backend has
     * stopped: with its window, which starts Cerium again when Cerium restarted for the update. Its
     * processes are gone by then, so it neither waits for them nor kills them.
     */
    installOnExit: () => {
      if (!windows || (status.kind !== "ready" && status.kind !== "installing")) return;
      (autoUpdater as BaseUpdater).install(false, status.kind === "installing");
    },
  };
};
