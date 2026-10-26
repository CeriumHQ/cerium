import { contextBridge, ipcRenderer, webUtils } from "electron";

// Sandboxed preload: the UI talks to the backend over its own RPC connection, so the bridge only
// tells the page it is running inside Cerium's shell and where the shell's backend listens, offers
// the native dialogs it can't open, and passes on the theme the system should draw the window's glass
// and caption buttons in, and the scale it is drawn at. The page says when its launch screen has painted, which shows the window. It also tells the page where a pasted file lives and shows a file in
// the file manager or opens it in its own app, none of which a page can do itself. Right-clicks no page menu claimed come
// through here for the page's text menu, whose commands the shell runs. The page reports whether the
// machine is signed in and working, which keep it in the tray and awake, and turns start at login on
// or off. Updates come through here too: the shell checks, downloads and installs them. The page
// asks for native notifications and the taskbar badge, and hears which thread a clicked toast opens.
// The main window opens a thread in a window of its own.
// Dictation opens Windows' or macOS's microphone privacy settings when they block it. The Preview
// pane's pages are the shell's; the page says where its pane is and passes on the agents' calls.
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
  saveText: (text: string, name: string, format: "markdown" | "text"): Promise<boolean> =>
    ipcRenderer.invoke("cerium:save-text", text, name, format),
  openHtml: (html: string, name: string): Promise<void> => ipcRenderer.invoke("cerium:open-html", html, name),
  setTheme: (theme: "system" | "dark" | "light"): Promise<boolean> =>
    ipcRenderer.invoke("cerium:set-theme", theme),
  onDarkColorsChange: (listener: (dark: boolean) => void): (() => void) => {
    const forward = (_event: unknown, dark: unknown) => listener(dark === true);
    ipcRenderer.on("cerium:dark-colors", forward);
    return () => ipcRenderer.off("cerium:dark-colors", forward);
  },
  setZoom: (factor: number): void => ipcRenderer.send("cerium:set-zoom", factor),
  windowReady: (): void => ipcRenderer.send("cerium:window-ready"),
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
  openThreadWindow: (threadId: string, mode: "work" | "chat"): void =>
    ipcRenderer.send("cerium:open-thread-window", threadId, mode),
  onOpenThread: (listener: (threadId: string) => void): (() => void) => {
    const forward = (_event: unknown, threadId: unknown) => {
      if (typeof threadId === "string") listener(threadId);
    };
    ipcRenderer.on("cerium:open-thread", forward);
    return () => ipcRenderer.off("cerium:open-thread", forward);
  },
  // The Preview pane's pages, which the shell lays over the window where the pane says, and the
  // agents' calls on them, which the page hands on from its backend.
  preview: {
    run: (threadId: string, command: unknown): Promise<unknown> =>
      ipcRenderer.invoke("cerium:preview-run", threadId, command),
    place: (threadId: string, bounds: { x: number; y: number; width: number; height: number } | null): void =>
      ipcRenderer.send("cerium:preview-place", threadId, bounds),
    navigate: (threadId: string, input: string): Promise<boolean> =>
      ipcRenderer.invoke("cerium:preview-navigate", threadId, input),
    go: (threadId: string, go: "back" | "forward" | "reload" | "stop"): void =>
      ipcRenderer.send("cerium:preview-go", threadId, go),
    close: (threadId: string): void => ipcRenderer.send("cerium:preview-close", threadId),
    still: (threadId: string): Promise<string | undefined> =>
      ipcRenderer.invoke("cerium:preview-still", threadId),
    states: (): Promise<unknown> => ipcRenderer.invoke("cerium:preview-states"),
    onState: (listener: (state: unknown) => void): (() => void) => {
      const forward = (_event: unknown, state: unknown) => listener(state);
      ipcRenderer.on("cerium:preview-state", forward);
      return () => ipcRenderer.off("cerium:preview-state", forward);
    },
    onClosed: (listener: (threadId: string) => void): (() => void) => {
      const forward = (_event: unknown, threadId: unknown) => {
        if (typeof threadId === "string") listener(threadId);
      };
      ipcRenderer.on("cerium:preview-closed", forward);
      return () => ipcRenderer.off("cerium:preview-closed", forward);
    },
  },
  microphoneAccess: (): Promise<string> => ipcRenderer.invoke("cerium:microphone-access"),
  // Linux has no microphone privacy page to open.
  ...(process.platform === "win32" || process.platform === "darwin"
    ? {
        openMicrophoneSettings: (): Promise<void> => ipcRenderer.invoke("cerium:open-microphone-settings"),
      }
    : {}),
});
