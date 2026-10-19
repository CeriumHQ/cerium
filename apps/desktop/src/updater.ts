import { app, BrowserWindow } from "electron";
import electronUpdater from "electron-updater";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Updating Cerium from within. The installed app follows one release
// channel's GitHub Releases through electron-updater: stable's latest release, or the newest
// nightly. The UI shows what this module reports and asks it to check, download and install;
// nothing downloads until the user asks. It checks at launch and every few hours, so a window that
// lives in the tray still hears of updates. When the releases can't be reached (offline, or not
// published where the app can read them) it says so and offers nothing to install.

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
  /** The releases couldn't be read: `offline`, or `unpublished` when the channel has none to read. */
  | { readonly kind: "unreachable"; readonly reason: "offline" | "unpublished"; readonly checkedAt: number }
  | { readonly kind: "failed"; readonly version: string };

export interface Updates {
  readonly channel: UpdateChannel;
  /** The running build's version and channel. */
  readonly version: string;
  readonly buildChannel: UpdateChannel;
  readonly status: UpdateStatus;
}

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

export const startUpdater = () => {
  const preferenceFile = join(app.getPath("userData"), "update-channel");
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
  let status: UpdateStatus = app.isPackaged ? { kind: "checking" } : { kind: "unsupported" };

  const snapshot = (): Updates => ({
    channel,
    version: app.getVersion(),
    buildChannel: buildChannel(),
    status,
  });
  const set = (next: UpdateStatus) => {
    status = next;
    const updates = snapshot();
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("cerium:updates", updates);
  };

  autoUpdater.logger = { info: log("info"), warn: log("warn"), error: log("error"), debug: () => undefined };
  autoUpdater.autoDownload = false;
  // A downloaded update the user didn't restart for installs as Cerium quits.
  autoUpdater.autoInstallOnAppQuit = true;

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

  let checking: Promise<void> | undefined;
  const check = (): Promise<void> => {
    if (!app.isPackaged) return Promise.resolve();
    // Downloading or downloaded: that build is what there is to offer until it installs.
    if (status.kind === "downloading" || status.kind === "ready") return Promise.resolve();
    if (checking !== undefined) return checking;
    set({ kind: "checking" });
    checking = autoUpdater
      .checkForUpdates()
      .then(
        (result) =>
          set(
            result?.isUpdateAvailable === true
              ? { kind: "available", version: result.updateInfo.version }
              : { kind: "current", checkedAt: Date.now() },
          ),
        (error: unknown) => set({ kind: "unreachable", reason: reasonFor(error), checkedAt: Date.now() }),
      )
      .finally(() => {
        checking = undefined;
      });
    return checking;
  };

  autoUpdater.on("download-progress", (progress: { percent: number }) => {
    if (status.kind === "downloading") set({ ...status, percent: progress.percent });
  });

  const download = async (): Promise<void> => {
    if (status.kind !== "available" && status.kind !== "failed") return;
    const { version } = status;
    set({ kind: "downloading", version, percent: 0 });
    try {
      await autoUpdater.downloadUpdate();
      set({ kind: "ready", version });
    } catch (error) {
      log("error")(error);
      set({ kind: "failed", version });
    }
  };

  if (app.isPackaged) {
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
      if (next !== channel && status.kind !== "downloading" && status.kind !== "ready") {
        channel = next;
        writeFileSync(preferenceFile, next);
        follow(next);
        await check();
      }
      return snapshot();
    },
    download,
    /** Quits and runs the downloaded installer silently, then starts the new build. */
    install: () => {
      if (status.kind === "ready") autoUpdater.quitAndInstall(true, true);
    },
  };
};
