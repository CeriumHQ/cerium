import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vite-plus/test";

const desktop = vi.hoisted(() => ({
  dir: "",
  working: false,
  checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo: { version: "2.0.0" } }),
  downloadUpdate: vi.fn<() => Promise<void>>(),
  quitAndInstall: vi.fn<() => void>(),
  quit: vi.fn<() => void>(),
}));
vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "1.0.0", getPath: () => desktop.dir, quit: desktop.quit },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("electron-updater", () => ({ default: { autoUpdater: { ...desktop, on: () => {} } } }));
vi.mock("../src/crashReports.ts", () => ({ reportCrash: () => {} }));
vi.mock("../src/linuxInstall.ts", () => ({ linuxInstall: () => ({ kind: "appimage" }) }));
vi.mock("../src/macUpdates.ts", () => ({ macBundlePath: () => "", macUpdateMode: async () => "native" }));

import { startUpdater } from "../src/updater.ts";

const apply = { kind: "apply", version: "2.0.0" } as const;
const restarts = () => desktop.quitAndInstall.mock.calls.length + desktop.quit.mock.calls.length;
const start = () =>
  startUpdater({ working: () => desktop.working, stopBackend: async () => {}, changed: () => {} });

describe("updates requested from another device", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    desktop.dir = mkdtempSync(join(tmpdir(), "cerium-updater-test-"));
    desktop.working = false;
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(desktop.dir, { recursive: true, force: true });
  });

  it("takes over a background download and restarts once without another request", async () => {
    const file = Promise.withResolvers<void>();
    desktop.downloadUpdate.mockReturnValue(file.promise);
    const updater = start();
    await updater.check();
    expect(updater.remote({ ...apply, version: "1.5.0" }).restart).toBe("idle");
    expect(updater.remote(apply).restart).toBe("requested");
    updater.remote(apply);
    expect(desktop.downloadUpdate).toHaveBeenCalledTimes(1);
    file.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(updater.remote(null).status.kind).toBe("installing");
    updater.remote(apply);
    expect(restarts()).toBe(1);
  });

  it("keeps the download ready when work starts and retries the restart without downloading again", async () => {
    const file = Promise.withResolvers<void>();
    desktop.downloadUpdate.mockReturnValue(file.promise);
    const updater = start();
    updater.setAutoDownload(false);
    await updater.check();
    expect(updater.remote(apply).status.kind).toBe("downloading");
    desktop.working = true;
    file.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(updater.remote(null)).toMatchObject({ status: { kind: "ready" }, restart: "working" });
    expect(restarts()).toBe(0);
    desktop.working = false;
    updater.remote(apply);
    await vi.advanceTimersByTimeAsync(0);
    expect(restarts()).toBe(1);
    expect(desktop.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("clears restart intent on a failed download so a later automatic download only stages", async () => {
    desktop.downloadUpdate.mockRejectedValueOnce(Object.assign(new Error("offline"), { code: "ENOTFOUND" }));
    const updater = start();
    updater.setAutoDownload(false);
    await updater.check();
    updater.remote(apply);
    await vi.advanceTimersByTimeAsync(0);
    expect(updater.remote(null)).toMatchObject({ status: { kind: "failed" }, restart: "idle" });
    desktop.downloadUpdate.mockResolvedValueOnce(undefined);
    updater.setAutoDownload(true);
    await updater.check();
    expect(updater.remote(null).status.kind).toBe("ready");
    expect(restarts()).toBe(0);
  });
});
