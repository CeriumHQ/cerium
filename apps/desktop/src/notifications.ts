import { app, nativeImage, Notification, type BrowserWindow } from "electron";

// Native notifications. The UI decides when one is worth showing (the user isn't looking at the
// window) and how many threads wait on the user since they last looked; the shell shows the toast,
// with the system's own sound unless the user turned it off, flashes the taskbar button when a thread
// needs them (on Linux, marks the window urgent; on macOS, bounces the Dock icon once), and draws the
// count over the taskbar icon, on macOS as the Dock icon's badge, or on Linux hands it to launchers
// that show one (KDE's, Ubuntu's dock).

/** What the UI asks to show; a click on it opens `threadId`. */
export interface NotificationRequest {
  readonly threadId: string;
  readonly title: string;
  readonly body: string;
  readonly silent: boolean;
  /** Flash the taskbar button until the window is focused. */
  readonly attention: boolean;
}

export const isNotificationRequest = (value: unknown): value is NotificationRequest => {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request["threadId"] === "string" &&
    typeof request["title"] === "string" &&
    typeof request["body"] === "string" &&
    typeof request["silent"] === "boolean" &&
    typeof request["attention"] === "boolean"
  );
};

/** The taskbar badge: how many threads, and the icon the UI drew for that number. */
export interface BadgeRequest {
  readonly count: number;
  /** A `data:image/png;base64,` URL; absent with a count of 0. */
  readonly icon?: string;
}

export const isBadgeRequest = (value: unknown): value is BadgeRequest => {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request["count"] === "number" &&
    Number.isInteger(request["count"]) &&
    request["count"] >= 0 &&
    (request["icon"] === undefined ||
      (typeof request["icon"] === "string" && request["icon"].startsWith("data:image/png;base64,")))
  );
};

/**
 * Names the app to Windows, which shows toasts only for an app it knows: the installer's shortcut
 * carries the same id as `appId` in electron-builder.ts. A development Electron goes by its path.
 */
export const nameAppForNotifications = () => {
  if (process.platform === "win32")
    app.setAppUserModelId(app.isPackaged ? "app.cerium.desktop" : process.execPath);
};

export const nativeNotifications = (options: {
  readonly window: () => BrowserWindow | undefined;
  /** Brings the window back, from the tray too. */
  readonly show: () => void;
}) => {
  // Kept until dismissed: a toast whose object is collected no longer reports its click.
  const showing = new Set<Notification>();

  const notify = (request: NotificationRequest) => {
    if (!Notification.isSupported()) return;
    const toast = new Notification({
      title: request.title,
      body: request.body,
      silent: request.silent,
    });
    showing.add(toast);
    const forget = () => showing.delete(toast);
    toast.on("click", () => {
      forget();
      options.show();
      options.window()?.webContents.send("cerium:open-thread", request.threadId);
    });
    toast.on("close", forget);
    toast.on("failed", forget);
    toast.show();
    const window = options.window();
    if (request.attention && window !== undefined && !window.isFocused()) window.flashFrame(true);
  };

  const setBadge = (request: BadgeRequest) => {
    const window = options.window();
    if (process.platform === "win32") {
      if (window === undefined) return;
      const icon = request.count > 0 && request.icon !== undefined ? request.icon : undefined;
      window.setOverlayIcon(
        icon === undefined ? null : nativeImage.createFromDataURL(icon),
        request.count === 1 ? "1 thread waiting" : `${request.count} threads waiting`,
      );
    } else {
      app.setBadgeCount(request.count);
    }
  };

  return {
    notify,
    setBadge,
    /** Stops flashing once the user comes back. */
    watch: (window: BrowserWindow) => window.on("focus", () => window.flashFrame(false)),
  };
};
