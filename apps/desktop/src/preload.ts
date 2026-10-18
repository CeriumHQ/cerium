import { contextBridge, ipcRenderer, webUtils } from "electron";

// Sandboxed preload: the UI talks to the backend over its own RPC connection, so the bridge only
// tells the page it is running inside Cerium's shell and where the shell's backend listens, offers
// the native dialogs it can't open, and passes on the theme Windows should draw the window's glass
// and caption buttons in. It also tells the page where a pasted file lives and shows a file in
// File Explorer, neither of which a page can do itself.
contextBridge.exposeInMainWorld("cerium", {
  shell: "electron",
  platform: process.platform,
  backendConnection: (): Promise<{ url: string; token: string } | undefined> =>
    ipcRenderer.invoke("cerium:backend-connection"),
  pickFolder: (): Promise<string | undefined> => ipcRenderer.invoke("cerium:pick-folder"),
  // Empty for a file that only exists in memory, such as a pasted screenshot.
  pathForFile: (file: File): string | undefined => webUtils.getPathForFile(file) || undefined,
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke("cerium:reveal-path", path),
  setTheme: (theme: "system" | "dark" | "light"): Promise<boolean> =>
    ipcRenderer.invoke("cerium:set-theme", theme),
  onDarkColorsChange: (listener: (dark: boolean) => void): (() => void) => {
    const forward = (_event: unknown, dark: unknown) => listener(dark === true);
    ipcRenderer.on("cerium:dark-colors", forward);
    return () => ipcRenderer.off("cerium:dark-colors", forward);
  },
});
