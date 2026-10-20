import { contextBridge, ipcRenderer, webUtils } from "electron";

// Sandboxed preload: the UI talks to the backend over its own RPC connection, so the bridge only
// tells the page it is running inside Cerium's shell and where the shell's backend listens, offers
// the native dialogs it can't open, and passes on the theme Windows should draw the window's glass
// and caption buttons in. It also tells the page where a pasted file lives and shows a file in
// File Explorer or opens it in its own app, none of which a page can do itself. Right-clicks no page menu claimed come
// through here for the page's text menu, whose commands the shell runs. The page reports whether the
// machine is signed in and working, which keep it in the tray and awake, and turns start at login on
// or off. Updates come through here too: the shell checks, downloads and installs them. The page
// asks for native notifications and the taskbar badge, and hears which thread a clicked toast opens.
contextBridge.exposeInMainWorld("cerium", {
  shell: "electron",
  platform: process.platform,
  backendConnection: (): Promise<{ url: string; token: string } | undefined> =>
    ipcRenderer.invoke("cerium:backend-connection"),
  pickFolder: (): Promise<string | undefined> => ipcRenderer.invoke("cerium:pick-folder"),
  // Empty for a file that only exists in memory, such as a pasted screenshot.
  pathForFile: (file: File): string | undefined => webUtils.getPathForFile(file) || undefined,
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke("cerium:reveal-path", path),
  openPath: (path: string): Promise<void> => ipcRenderer.invoke("cerium:open-path", path),
  saveImage: (source: string, name: string): Promise<boolean> =>
    ipcRenderer.invoke("cerium:save-image", source, name),
  setTheme: (theme: "system" | "dark" | "light"): Promise<boolean> =>
    ipcRenderer.invoke("cerium:set-theme", theme),
  onDarkColorsChange: (listener: (dark: boolean) => void): (() => void) => {
    const forward = (_event: unknown, dark: unknown) => listener(dark === true);
    ipcRenderer.on("cerium:dark-colors", forward);
    return () => ipcRenderer.off("cerium:dark-colors", forward);
  },
  onTextMenu: (listener: (request: unknown) => void): (() => void) => {
    const forward = (_event: unknown, request: unknown) => listener(request);
    ipcRenderer.on("cerium:text-menu", forward);
    return () => ipcRenderer.off("cerium:text-menu", forward);
  },
  runTextCommand: (command: unknown): Promise<void> => ipcRenderer.invoke("cerium:text-command", command),
  setPresence: (presence: { signedIn: boolean; working: boolean }): void =>
    ipcRenderer.send("cerium:presence", presence),
  startAtLogin: (): Promise<{ available: boolean; enabled: boolean }> =>
    ipcRenderer.invoke("cerium:start-at-login"),
  setStartAtLogin: (enabled: boolean): Promise<{ available: boolean; enabled: boolean }> =>
    ipcRenderer.invoke("cerium:set-start-at-login", enabled),
  updates: (): Promise<unknown> => ipcRenderer.invoke("cerium:updates"),
  checkForUpdates: (): Promise<unknown> => ipcRenderer.invoke("cerium:check-for-updates"),
  setUpdateChannel: (channel: "stable" | "nightly"): Promise<unknown> =>
    ipcRenderer.invoke("cerium:set-update-channel", channel),
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke("cerium:download-update"),
  installUpdate: (): Promise<void> => ipcRenderer.invoke("cerium:install-update"),
  onUpdatesChange: (listener: (updates: unknown) => void): (() => void) => {
    const forward = (_event: unknown, updates: unknown) => listener(updates);
    ipcRenderer.on("cerium:updates", forward);
    return () => ipcRenderer.off("cerium:updates", forward);
  },
  notify: (request: {
    threadId: string;
    title: string;
    body: string;
    silent: boolean;
    attention: boolean;
  }): void => ipcRenderer.send("cerium:notify", request),
  setBadge: (badge: { count: number; icon?: string }): void => ipcRenderer.send("cerium:set-badge", badge),
  onOpenThread: (listener: (threadId: string) => void): (() => void) => {
    const forward = (_event: unknown, threadId: unknown) => {
      if (typeof threadId === "string") listener(threadId);
    };
    ipcRenderer.on("cerium:open-thread", forward);
    return () => ipcRenderer.off("cerium:open-thread", forward);
  },
});
