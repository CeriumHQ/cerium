import { contextBridge, ipcRenderer } from "electron";

// Sandboxed preload: the UI talks to the backend over its own RPC connection, so the bridge only
// tells the page it is running inside Cerium's shell and offers the native dialogs it can't open.
contextBridge.exposeInMainWorld("cerium", {
  shell: "electron",
  platform: process.platform,
  pickFolder: (): Promise<string | undefined> => ipcRenderer.invoke("cerium:pick-folder"),
});
