import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { isAbsolute, join, normalize } from "node:path";

import { backgroundMode, HIDDEN_FLAG, isPresence, setStartAtLogin, startAtLogin } from "./background.ts";
import { startBackend } from "./backend.ts";
import { saveImage } from "./saveImage.ts";
import { forwardTextMenus, runTextCommand } from "./textMenu.ts";
import { isUpdateChannel, startUpdater } from "./updater.ts";
import { restoreNativeFrame } from "./windowFrame.ts";

// The thin shell (docs/architecture.md §7): a window with Windows Acrylic and native caption buttons
// around the UI, the backend's launcher, and the tray that keeps a signed-in machine reachable
// (background.ts), and the updater (updater.ts). Everything else lives in the UI and the backend.

// One Cerium at a time: launching it again shows the one that's running, which may be in the tray.
if (!app.requestSingleInstanceLock()) app.quit();

/**
 * `--dev-url=<url>` loads the UI from Vite's dev server instead of the built files. The development
 * backend then runs on its own (`bun run dev`) and the UI finds it through the dev server.
 */
const devUrl = process.argv.find((arg) => arg.startsWith("--dev-url="))?.slice("--dev-url=".length);

let backend: ReturnType<typeof startBackend> | undefined;
let updater: ReturnType<typeof startUpdater> | undefined;
let mainWindow: BrowserWindow | undefined;

/** Started at login: straight to the tray, unless the UI says this machine isn't signed in. */
const startHidden = process.argv.includes(HIDDEN_FLAG);
/** How long a hidden start waits to hear whether it's signed in before showing the window anyway. */
const HIDDEN_START_TIMEOUT_MS = 15_000;

const background = backgroundMode({
  icon: join(import.meta.dirname, "..", "build", "icon.ico"),
  window: () => mainWindow,
});

/** Links the UI may open in the browser: https, and the local relay while developing. */
const opensExternally = (url: string) =>
  url.startsWith("https://") || (!app.isPackaged && /^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(url));

/** Matches the UI titlebar's height so the caption buttons line up with it. */
const TITLEBAR_HEIGHT = 40;

/** Windows draws the caption buttons; their symbols follow the theme like the UI's own text. */
const titleBarOverlay = () => ({
  color: "#00000000",
  symbolColor: nativeTheme.shouldUseDarkColors ? "#e6e6e6" : "#262626",
  height: TITLEBAR_HEIGHT,
});

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
    titleBarOverlay: titleBarOverlay(),
    // The installed app takes its icon from its executable; this is for `bun run dev`, which runs
    // Electron's own.
    ...(devUrl === undefined ? {} : { icon: join(import.meta.dirname, "..", "build", "icon.png") }),
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
  window.once("ready-to-show", () => {
    if (!startHidden) window.show();
  });
  window.on("close", (event) => {
    if (background.interceptClose()) event.preventDefault();
  });
  window.on("closed", () => {
    mainWindow = undefined;
  });

  // Links open in the user's browser, never inside the app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (opensExternally(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  forwardTextMenus(window.webContents);

  if (devUrl === undefined) {
    void window.loadFile(join(import.meta.dirname, "..", "..", "ui", "dist", "index.html"));
  } else {
    void window.loadURL(devUrl);
  }
  mainWindow = window;
};

/**
 * Whether this machine is signed in and agents are working, which decide whether closing the window
 * hides it to the tray and whether the PC may sleep. A hidden start shows the window once it hears
 * the machine isn't signed in, since nothing would keep it reachable.
 */
let heardPresence = false;
ipcMain.on("cerium:presence", (_event, presence: unknown) => {
  if (!isPresence(presence)) return;
  background.update(presence);
  if (startHidden && !heardPresence && !presence.signedIn) background.show();
  heardPresence = true;
});

/** Whether Cerium starts when the user signs in to Windows; only the installed app can. */
ipcMain.handle("cerium:start-at-login", () => startAtLogin());
ipcMain.handle("cerium:set-start-at-login", (_event, enabled: unknown) =>
  typeof enabled === "boolean" ? setStartAtLogin(enabled) : startAtLogin(),
);

app.on("second-instance", () => background.show());

/** Updating Cerium: the chosen channel, what it offers, and downloading and installing it. */
ipcMain.handle("cerium:updates", () => updater?.updates());
ipcMain.handle("cerium:check-for-updates", () => updater?.check());
ipcMain.handle("cerium:set-update-channel", (_event, channel: unknown) =>
  isUpdateChannel(channel) ? updater?.setChannel(channel) : updater?.updates(),
);
ipcMain.handle("cerium:download-update", () => updater?.download());
ipcMain.handle("cerium:install-update", () => updater?.install());

/** Where the UI connects to the backend this shell runs; nothing in development. */
ipcMain.handle("cerium:backend-connection", () => backend?.connection());

/** The folder a work thread runs in, chosen with the native dialog. */
ipcMain.handle("cerium:pick-folder", async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options = { properties: ["openDirectory" as const, "createDirectory" as const] };
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
});

/** Shows a file the transcript names in File Explorer; only absolute paths, and nothing is opened. */
ipcMain.handle("cerium:reveal-path", (_event, target: unknown) => {
  if (typeof target === "string" && isAbsolute(target)) shell.showItemInFolder(normalize(target));
});

/** Saves an image the transcript shows, where the user picks; resolves whether it was saved. */
ipcMain.handle("cerium:save-image", (event, source: unknown, name: unknown) =>
  saveImage(event.sender, source, name),
);

/** A command from the app-wide text menu, run on the right-click it was opened for. */
ipcMain.handle("cerium:text-command", (event, command: unknown) => runTextCommand(event.sender, command));

/**
 * The UI's theme choice. Windows tints Acrylic from the native theme, so it follows the UI. Answers
 * whether that means dark colours: after a forced theme, the page's `prefers-color-scheme` doesn't
 * return to Windows' own when the choice goes back to "system", so the UI asks here instead.
 */
ipcMain.handle("cerium:set-theme", (_event, theme: unknown) => {
  if (theme === "system" || theme === "dark" || theme === "light") nativeTheme.themeSource = theme;
  return nativeTheme.shouldUseDarkColors;
});

// Windows switching between light and dark, or the UI changing the theme.
nativeTheme.on("updated", () => {
  for (const window of BrowserWindow.getAllWindows()) {
    window.setTitleBarOverlay(titleBarOverlay());
    window.webContents.send("cerium:dark-colors", nativeTheme.shouldUseDarkColors);
  }
});

void app.whenReady().then(() => {
  if (devUrl === undefined) backend = startBackend();
  updater = startUpdater();
  // Dark until the UI loads and reports the user's choice.
  nativeTheme.themeSource = "dark";
  createWindow();
  if (startHidden) {
    setTimeout(() => {
      if (!heardPresence) background.show();
    }, HIDDEN_START_TIMEOUT_MS);
  }
});

app.on("window-all-closed", () => app.quit());

// Quitting waits for the backend to shut down, so it closes its harness sessions and database.
let backendStopped = false;
app.on("will-quit", (event) => {
  if (backend === undefined || backendStopped) return;
  event.preventDefault();
  void backend.stop().then(() => {
    backendStopped = true;
    app.quit();
  });
});
