import { app, Menu, powerSaveBlocker, Tray, type BrowserWindow } from "electron";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Staying reachable. While this machine is signed in to a Cerium
// account, closing the window hides it to the tray, so the user's other devices can still reach it,
// and while agents also work the PC is kept from sleeping. The UI reports both; signed out, the
// window closes and quits as it always has.

/** What the UI reports: whether this machine is signed in, and whether any agent is working. */
export interface Presence {
  readonly signedIn: boolean;
  readonly working: boolean;
}

export const isPresence = (value: unknown): value is Presence =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { signedIn?: unknown }).signedIn === "boolean" &&
  typeof (value as { working?: unknown }).working === "boolean";

/** The flag the login item starts Cerium with: straight to the tray. */
export const HIDDEN_FLAG = "--hidden";

/** Start at login only makes sense for the installed app; a development Electron isn't Cerium. */
export const startAtLogin = () => ({
  available: app.isPackaged,
  enabled: app.isPackaged && app.getLoginItemSettings({ args: [HIDDEN_FLAG] }).openAtLogin,
});

export const setStartAtLogin = (enabled: boolean) => {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_FLAG] });
  return startAtLogin();
};

/** Keeps the window, the tray and the power blocker in step with what the UI reports. */
export const backgroundMode = (options: {
  readonly icon: string;
  readonly window: () => BrowserWindow | undefined;
}) => {
  let presence: Presence = { signedIn: false, working: false };
  let quitting = false;
  let tray: Tray | undefined;
  let blocker: number | undefined;

  const show = () => {
    const window = options.window();
    if (window === undefined) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };

  const quit = () => {
    quitting = true;
    app.quit();
  };

  const syncTray = () => {
    if (presence.signedIn && tray === undefined) {
      tray = new Tray(options.icon);
      tray.setToolTip("Cerium · reachable from your other devices");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "Open Cerium", click: show },
          { type: "separator" },
          { label: "Quit Cerium", click: quit },
        ]),
      );
      tray.on("click", show);
    } else if (!presence.signedIn && tray !== undefined) {
      tray.destroy();
      tray = undefined;
    }
  };

  const syncBlocker = () => {
    const wanted = presence.signedIn && presence.working;
    if (wanted && blocker === undefined) blocker = powerSaveBlocker.start("prevent-app-suspension");
    if (!wanted && blocker !== undefined) {
      powerSaveBlocker.stop(blocker);
      blocker = undefined;
    }
  };

  /** Says once, the first time ever, where the window went. */
  const hintOnce = () => {
    const shown = join(app.getPath("userData"), "tray-hint-shown");
    if (tray === undefined || existsSync(shown)) return;
    tray.displayBalloon({
      iconType: "info",
      title: "Cerium is still running",
      content: "Your other devices can reach this machine. Open or quit Cerium from here.",
    });
    writeFileSync(shown, "");
  };

  app.on("before-quit", () => {
    quitting = true;
  });

  return {
    show,
    /** Hides instead of closing while signed in; returns whether it did. */
    interceptClose: () => {
      if (!presence.signedIn || quitting) return false;
      options.window()?.hide();
      hintOnce();
      return true;
    },
    update: (next: Presence) => {
      presence = next;
      syncTray();
      syncBlocker();
    },
    signedIn: () => presence.signedIn,
  };
};
