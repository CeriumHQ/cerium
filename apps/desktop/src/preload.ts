import { contextBridge } from "electron";

// Sandboxed preload: the UI talks to the backend over its own RPC connection, so the bridge only
// tells the page it is running inside Cerium's shell.
contextBridge.exposeInMainWorld("cerium", {
  shell: "electron",
  platform: process.platform,
});
