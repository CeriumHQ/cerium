import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { autostartEnabled, autostartProgram, setAutostart } from "./autostart.ts";

// Staying reachable. While this machine is signed in to a Cerium
// account, closing the window hides it to the tray, so the user's other devices can still reach it,
// and the PC is kept from sleeping while agents work, or longer as the user's Keep awake setting
// says. The backend reports both; signed out, the window closes and quits as it always has.

/** The flag the login item starts Cerium with: straight to the tray. */
export const HIDDEN_FLAG = "--hidden";

/**
 * When a signed-in machine is kept from sleeping: while agents work, also whenever it's plugged in,
 * or always. Each keeps it awake while agents work.
 */
export type KeepAwake = "working" | "ac" | "always";
export const KEEP_AWAKE_MODES: ReadonlyArray<KeepAwake> = ["working", "ac", "always"];
export const keepAwakeLabel: Record<KeepAwake, string> = {
  working: "While agents work",
  ac: "While plugged in",
  always: "Always",
};
export const isKeepAwake = (value: unknown): value is KeepAwake =>
  KEEP_AWAKE_MODES.includes(value as KeepAwake);

/** Whether the machine is kept from sleeping now. */
export const keepsAwake = (state: {
  readonly signedIn: boolean;
  readonly working: boolean;
  readonly mode: KeepAwake;
  readonly onBattery: boolean;
}): boolean =>
  state.signedIn && (state.working || state.mode === "always" || (state.mode === "ac" && !state.onBattery));

const REACHABLE_TOOLTIP = "Cerium · reachable from your other devices";
const AWAKE_TOOLTIP = "Cerium · staying awake for your other devices";

/** How long nobody touches the computer before its window stops counting as attended. */
export const IDLE_AWAY_SECONDS = 120;
/** How often the system's idle time is read while a window has focus. */
const IDLE_POLL_MS = 5_000;
/** A focus moving between Cerium's windows blurs one just before it focuses the next. */
const FOCUS_SETTLE_MS = 100;

/** Whether the user is at this computer's Cerium: a window of it has focus, and they're active. */
export const isAttended = (state: {
  readonly focused: boolean;
  readonly locked: boolean;
  readonly idleSeconds: number;
}): boolean => state.focused && !state.locked && state.idleSeconds < IDLE_AWAY_SECONDS;

/**
 * Follows whether the user is at Cerium (`isAttended`), so the account isn't told this computer is
 * looked at, and their phone kept quiet, while it sits unfocused or idle. Call once the app is ready.
 */
export const watchAttention = (onChange: (attended: boolean) => void) => {
  let focused = BrowserWindow.getFocusedWindow() !== null;
  let locked = false;
  const now = () =>
    isAttended({ focused, locked, idleSeconds: focused ? powerMonitor.getSystemIdleTime() : 0 });
  let attended = now();
  const check = () => {
    const next = now();
    if (next === attended) return;
    attended = next;
    onChange(next);
  };
  let settling: ReturnType<typeof setTimeout> | undefined;
  const refocus = () => {
    clearTimeout(settling);
    settling = setTimeout(() => {
      focused = BrowserWindow.getFocusedWindow() !== null;
      check();
    }, FOCUS_SETTLE_MS);
  };
  const lock = (next: boolean) => () => {
    locked = next;
    check();
  };
  app.on("browser-window-focus", refocus);
  app.on("browser-window-blur", refocus);
  powerMonitor.on("lock-screen", lock(true));
  powerMonitor.on("suspend", lock(true));
  powerMonitor.on("unlock-screen", lock(false));
  powerMonitor.on("resume", lock(false));
  setInterval(() => {
    if (focused) check();
  }, IDLE_POLL_MS).unref();
  return { attended: () => attended };
};

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
  /** The Keep awake setting changed, from the tray or the window. */
  readonly onKeepAwakeChange?: (mode: KeepAwake) => void;
}) => {
  let signedIn = false;
  let working = false;
  let attached = false;
  let quitting = false;
  let tray: Tray | undefined;
  let blocker: number | undefined;
  let onBattery: boolean | undefined;

  const keepAwakeFile = () => join(app.getPath("userData"), "keep-awake");
  let mode: KeepAwake | undefined;
  const keepAwake = (): KeepAwake => {
    if (mode !== undefined) return mode;
    try {
      const saved = readFileSync(keepAwakeFile(), "utf8").trim();
      mode = isKeepAwake(saved) ? saved : "working";
    } catch {
      mode = "working";
    }
    return mode;
  };

  /** Whether it runs on battery, followed from the first time it matters, once the app is ready. */
  const battery = () => {
    if (onBattery !== undefined) return onBattery;
    onBattery = powerMonitor.isOnBatteryPower();
    const follow = (next: boolean) => () => {
      onBattery = next;
      syncBlocker();
    };
    powerMonitor.on("on-ac", follow(false));
    powerMonitor.on("on-battery", follow(true));
    return onBattery;
  };

  const quit = () => {
    quitting = true;
    app.quit();
  };

  const trayMenu = () =>
    Menu.buildFromTemplate([
      { label: "Open Cerium", click: options.show },
      { type: "separator" },
      {
        label: "Keep awake",
        submenu: KEEP_AWAKE_MODES.map((each): MenuItemConstructorOptions => ({
          label: keepAwakeLabel[each],
          type: "radio",
          checked: each === keepAwake(),
          click: () => setKeepAwake(each),
        })),
      },
      { type: "separator" },
      { label: "Quit Cerium", click: quit },
    ]);

  const syncTray = () => {
    const keepInTray = signedIn && !attached;
    if (keepInTray && tray === undefined) {
      tray = new Tray(options.icon);
      tray.setContextMenu(trayMenu());
      tray.on("click", options.show);
    } else if (!keepInTray && tray !== undefined) {
      tray.destroy();
      tray = undefined;
    }
    tray?.setToolTip(blocker === undefined ? REACHABLE_TOOLTIP : AWAKE_TOOLTIP);
  };

  const syncBlocker = () => {
    const wanted =
      !attached &&
      keepsAwake({
        signedIn,
        working,
        mode: keepAwake(),
        onBattery: keepAwake() === "ac" && battery(),
      });
    if (wanted && blocker === undefined) blocker = powerSaveBlocker.start("prevent-app-suspension");
    if (!wanted && blocker !== undefined) {
      powerSaveBlocker.stop(blocker);
      blocker = undefined;
    }
    syncTray();
  };

  const setKeepAwake = (next: KeepAwake) => {
    if (next !== keepAwake()) {
      mode = next;
      try {
        writeFileSync(keepAwakeFile(), next);
      } catch {
        // Kept for this run; the next start falls back to the saved one.
      }
      options.onKeepAwakeChange?.(next);
    }
    tray?.setContextMenu(trayMenu());
    syncBlocker();
    return next;
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
      if (!signedIn || quitting || attached) return false;
      options.window()?.hide();
      hintOnce();
      return true;
    },
    setAttached: (next: boolean) => {
      attached = next;
      syncBlocker();
    },
    attached: () => attached,
    setSignedIn: (next: boolean) => {
      signedIn = next;
      syncBlocker();
    },
    setWorking: (next: boolean) => {
      working = next;
      syncBlocker();
    },
    keepAwake,
    setKeepAwake,
    signedIn: () => signedIn,
    working: () => working,
  };
};
