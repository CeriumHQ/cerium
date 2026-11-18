import { app, Menu, Notification, powerSaveBlocker, Tray, type BrowserWindow } from "electron";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { autostartEnabled, autostartProgram, setAutostart } from "./autostart.ts";

// Staying reachable. While this machine is signed in to a Cerium
// account, closing the window hides it to the tray, so the user's other devices can still reach it,
// and while agents also work the PC is kept from sleeping. The backend reports both; signed out, the
// window closes and quits as it always has.

/** The flag the login item starts Cerium with: straight to the tray. */
export const HIDDEN_FLAG = "--hidden";

/**
 * Start at login only makes sense for the installed app; a development Electron isn't Cerium. On
 * Linux it is an autostart entry for the AppImage or the installed package (autostart.ts).
 */
export const startAtLogin = async () => {
  if (process.platform === "linux") {
    const available = app.isPackaged && autostartProgram() !== undefined;
    return { available, enabled: available && (await autostartEnabled()) };
  }
  const settings = app.getLoginItemSettings({ args: [HIDDEN_FLAG] });
  return {
    available: app.isPackaged,
    enabled: app.isPackaged && settings.openAtLogin,
    // macOS 13 and later can hold a login item back until the user allows it in System Settings,
    // which an app without Apple's Developer ID certificate often has to ask for.
    needsApproval: app.isPackaged && process.platform === "darwin" && settings.status === "requires-approval",
  };
};

export const setStartAtLogin = async (enabled: boolean) => {
  if (!app.isPackaged) return startAtLogin();
  if (process.platform === "linux") await setAutostart(enabled, [HIDDEN_FLAG]);
  else app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_FLAG] });
  return startAtLogin();
};

/** Keeps the window, the tray and the power blocker in step with the backend. */
export const backgroundMode = (options: {
  readonly icon: string;
  readonly window: () => BrowserWindow | undefined;
  readonly show: () => void;
}) => {
  let signedIn = false;
  let working = false;
  let quitting = false;
  let tray: Tray | undefined;
  let blocker: number | undefined;

  const quit = () => {
    quitting = true;
    app.quit();
  };

  const syncTray = () => {
    if (signedIn && tray === undefined) {
      tray = new Tray(options.icon);
      tray.setToolTip("Cerium · reachable from your other devices");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "Open Cerium", click: options.show },
          { type: "separator" },
          { label: "Quit Cerium", click: quit },
        ]),
      );
      tray.on("click", options.show);
    } else if (!signedIn && tray !== undefined) {
      tray.destroy();
      tray = undefined;
    }
  };

  const syncBlocker = () => {
    const wanted = signedIn && working;
    if (wanted && blocker === undefined) blocker = powerSaveBlocker.start("prevent-app-suspension");
    if (!wanted && blocker !== undefined) {
      powerSaveBlocker.stop(blocker);
      blocker = undefined;
    }
  };

  /**
   * Says once, the first time ever, where the window went: in a balloon from the tray on Windows, in
   * a notification elsewhere, where trays show none.
   */
  const hintOnce = () => {
    const shown = join(app.getPath("userData"), "tray-hint-shown");
    if (tray === undefined || existsSync(shown)) return;
    const title = "Cerium is still running";
    if (process.platform === "win32") {
      tray.displayBalloon({
        iconType: "info",
        title,
        content: "Your other devices can reach this machine. Open or quit Cerium from here.",
      });
    } else if (Notification.isSupported()) {
      const where = process.platform === "darwin" ? "the menu bar or the Dock" : "its tray icon";
      new Notification({
        title,
        body: `Your other devices can reach this machine. Open or quit Cerium from ${where}.`,
      }).show();
    }
    writeFileSync(shown, "");
  };

  app.on("before-quit", () => {
    quitting = true;
  });

  return {
    /** Hides instead of closing while signed in; returns whether it did. */
    interceptClose: () => {
      if (!signedIn || quitting) return false;
      options.window()?.hide();
      hintOnce();
      return true;
    },
    setSignedIn: (next: boolean) => {
      signedIn = next;
      syncTray();
      syncBlocker();
    },
    setWorking: (next: boolean) => {
      working = next;
      syncBlocker();
    },
    signedIn: () => signedIn,
    working: () => working,
  };
};
