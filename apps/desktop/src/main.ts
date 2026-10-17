import { app, BrowserWindow, nativeTheme, shell } from "electron";
import { join } from "node:path";

import { restoreNativeFrame } from "./windowFrame.ts";

// The thin shell (docs/architecture.md §7): a window with Windows Acrylic and native caption buttons
// around the UI. Everything else lives in the UI and the backend.

/** `--dev-url=<url>` loads the UI from Vite's dev server instead of the built files. */
const devUrl = process.argv.find((arg) => arg.startsWith("--dev-url="))?.slice("--dev-url=".length);

/** Matches the UI titlebar's height so the caption buttons line up with it. */
const TITLEBAR_HEIGHT = 40;

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    // The page paints nothing behind its surfaces, so Windows' Acrylic shows through. Acrylic only
    // reaches the page area of a transparent window (electron/electron#47510); restoreNativeFrame puts
    // back the resize frame and rounded corners Electron removes from those.
    transparent: true,
    backgroundMaterial: "acrylic",
    backgroundColor: "#00000000",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#00000000", symbolColor: "#e6e6e6", height: TITLEBAR_HEIGHT },
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (process.platform === "win32") {
    restoreNativeFrame(window);
    // Electron re-applies its own frame style on some state changes.
    const reapply = () => restoreNativeFrame(window);
    window.on("maximize", reapply);
    window.on("unmaximize", reapply);
    window.on("restore", reapply);
  }
  window.once("ready-to-show", () => window.show());

  // Links open in the user's browser, never inside the app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });

  if (devUrl === undefined) {
    void window.loadFile(join(import.meta.dirname, "..", "..", "ui", "dist", "index.html"));
  } else {
    void window.loadURL(devUrl);
  }
};

void app.whenReady().then(() => {
  nativeTheme.themeSource = "dark";
  createWindow();
});

app.on("window-all-closed", () => app.quit());
