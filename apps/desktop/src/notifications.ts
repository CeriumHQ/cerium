import {
  NOTIFICATION_KINDS,
  notificationBody,
  type NotificationKind,
  type ThreadNotification,
} from "@cerium/protocol";
import { app, nativeImage, Notification, type BrowserWindow } from "electron";

import { handling } from "./notificationPolicy.ts";

/**
 * Names the app to Windows, which shows toasts only for an app it knows: the installer's shortcut
 * carries the same id as `appId` in electron-builder.ts. A development Electron goes by its path.
 */
export const nameAppForNotifications = () => {
  if (process.platform === "win32")
    app.setAppUserModelId(app.isPackaged ? "app.cerium.desktop" : process.execPath);
};

/** How many toasts are kept to report their click; the oldest is let go past it. */
const MAX_SHOWING = 50;

export const nativeNotifications = (options: {
  readonly window: () => BrowserWindow | undefined;
  readonly open: (threadId: string | undefined) => void;
  readonly threadWindow: (threadId: string) => BrowserWindow | undefined;
}) => {
  // Kept until dismissed: a toast whose object is collected no longer reports its click. macOS and
  // Linux don't always say when one expires, so only the latest are kept.
  const showing = new Set<Notification>();
  const waiting = new Set<string>();
  let kinds: ReadonlyArray<NotificationKind> = NOTIFICATION_KINDS;
  let silent = false;
  let badge = true;
  let viewing: string | undefined;
  let icons: ReadonlyArray<Electron.NativeImage> = [];

  const syncBadge = () => {
    const count = badge && kinds.length > 0 ? waiting.size : 0;
    if (process.platform === "win32") {
      options
        .window()
        ?.setOverlayIcon(
          icons[Math.min(count, 10) - 1] ?? null,
          count === 1 ? "1 thread waiting" : `${count} threads waiting`,
        );
    } else {
      app.setBadgeCount(count);
    }
  };

  const read = (threadId: string | undefined) => {
    if (threadId !== undefined && waiting.delete(threadId)) syncBadge();
  };

  const showToast = (title: string, body: string, quiet: boolean, threadId?: string) => {
    if (!Notification.isSupported()) return false;
    const toast = new Notification({ title, body, silent: quiet });
    showing.add(toast);
    if (showing.size > MAX_SHOWING) showing.delete(showing.values().next().value!);
    const forget = () => showing.delete(toast);
    toast.on("click", () => {
      forget();
      options.open(threadId);
    });
    toast.on("close", forget);
    toast.on("failed", forget);
    toast.show();
    return true;
  };

  const notify = (notification: ThreadNotification) => {
    const { threadId, kind, title, detail } = notification;
    if (threadId !== undefined && options.threadWindow(threadId)?.isFocused() === true) return;
    const window = options.window();
    const action = handling(notification, kinds, { atWindow: window?.isFocused() === true, viewing });
    if (action === "ignore") return;
    if (threadId !== undefined && !waiting.has(threadId)) {
      waiting.add(threadId);
      syncBadge();
    }
    if (action !== "show" || !showToast(title, notificationBody(kind, detail), silent, threadId)) return;
    if (kind === "needsYou" && window !== undefined && !window.isFocused()) window.flashFrame(true);
  };

  return {
    notify,
    test: (quiet: boolean) => showToast("Cerium", "Notifications are on for this computer.", quiet),
    configure: (preferences: { kinds: ReadonlyArray<NotificationKind>; silent: boolean; badge: boolean }) => {
      ({ kinds, silent, badge } = preferences);
      syncBadge();
    },
    view: (threadId: string | undefined) => {
      viewing = threadId;
      if (options.window()?.isFocused() === true) read(viewing);
    },
    setBadgeIcons: (values: ReadonlyArray<string>) => {
      icons = values.map((value) => nativeImage.createFromDataURL(value));
      syncBadge();
    },
    syncBadge,
    watch: (window: BrowserWindow, threadId?: string) =>
      window.on("focus", () => {
        window.flashFrame(false);
        read(threadId ?? viewing);
      }),
  };
};
