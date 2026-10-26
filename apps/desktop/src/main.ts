import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  session,
  shell,
  systemPreferences,
  type IpcMainEvent,
} from "electron";
import { isAbsolute, join, normalize } from "node:path";

import { backgroundMode, HIDDEN_FLAG, isPresence, setStartAtLogin, startAtLogin } from "./background.ts";
import { startBackend } from "./backend.ts";
import {
  isBadgeRequest,
  isNotificationRequest,
  nameAppForNotifications,
  nativeNotifications,
} from "./notifications.ts";
import { openHtml } from "./openHtml.ts";
import { openPath } from "./openPath.ts";
import { previews } from "./preview.ts";
import { saveImage } from "./saveImage.ts";
import {
  loginShellPath,
import { saveText } from "./saveText.ts";
  rememberedPath,
  rememberPath,
  sessionEnvironment,
  withShellPath,
} from "./shellPath.ts";
import { prepareSmokeTest, runSmokeTest } from "./smokeTest.ts";
import { forwardTextMenus, runTextCommand } from "./textMenu.ts";
import { isUpdateChannel, startUpdater } from "./updater.ts";
import { restoreNativeFrame } from "./windowFrame.ts";

// The thin shell: a window with native caption buttons around the UI, Acrylic behind it on Windows
// and Vibrancy on macOS, the backend's launcher, and the tray that keeps a signed-in machine
// reachable (background.ts), the updater (updater.ts) and the Preview pane's pages (preview.ts).
// Everything else lives in the UI and the backend.

/** `--smoke-test` checks a packaged build runs, on a user-data folder of its own (smokeTest.ts). */
const smokeTest = prepareSmokeTest();

// One Cerium at a time: launching it again shows the one that's running, which may be in the tray.
if (!app.requestSingleInstanceLock()) app.quit();

/**
 * `--dev-url=<url>` loads the UI from Vite's dev server instead of the built files; the last one given
 * wins, so `bun run dev` can name the port it picked. The development backend then runs on its own
 * (`bun run dev`) and the UI finds it through the dev server. The dev script also opens Chromium's
 * debugging port 9222, which `bun run ui open --attach=9222` drives. A packaged build ignores it, so
 * nothing that starts Cerium can load another page into the window, preload bridge and all.
 */
const devUrl = app.isPackaged
  ? undefined
  : process.argv.findLast((arg) => arg.startsWith("--dev-url="))?.slice("--dev-url=".length);

let backend: ReturnType<typeof startBackend> | undefined;
/** Settles once the packaged app's backend has started. */
let backendStarting: Promise<void> | undefined;
let updater: ReturnType<typeof startUpdater> | undefined;
let mainWindow: BrowserWindow | undefined;

const windows = process.platform === "win32";
const mac = process.platform === "darwin";
const linux = process.platform === "linux";

const appIcon = join(import.meta.dirname, "..", "build", "icon.png");

/**
 * Started at login: straight to the tray, unless the UI says this machine isn't signed in. Windows
 * and Linux start Cerium with a flag; macOS says so itself, and passes no arguments.
 */
const startHidden =
  process.argv.includes(HIDDEN_FLAG) ||
  (mac && app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin);
/** How long a hidden start waits to hear whether it's signed in before showing the window anyway. */
const HIDDEN_START_TIMEOUT_MS = 15_000;

const background = backgroundMode({
  // Linux trays take a PNG. The menu bar takes a template image, a black mark macOS tints to the bar,
  // and finds its @2x beside it.
  icon: join(
    import.meta.dirname,
    "..",
    "build",
    windows ? "icon.ico" : mac ? "trayTemplate.png" : "icon.png",
  ),
  window: () => mainWindow,
});

const notifications = nativeNotifications({ window: () => mainWindow, show: background.show });

/** The Preview pane's pages, one per thread, laid over the window (preview.ts). */
const browserPreviews = previews(() => mainWindow);

/** Links the UI may open in the browser: https, and the local relay while developing. */
const opensExternally = (url: string) =>
  url.startsWith("https://") || (!app.isPackaged && /^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(url));

/** How long after its first paint the window waits for the page's launch screen before showing. */
const WINDOW_READY_TIMEOUT_MS = 1_500;

/** Matches the UI titlebar's height so the caption buttons line up with it. */
const TITLEBAR_HEIGHT = 40;

/**
 * The system draws the caption buttons (Electron itself on Linux); their symbols follow the theme
 * like the UI's own text, and they grow with the window's zoom as the titlebar does. macOS draws its
 * traffic lights in its own colours, so only the height applies there.
 */
const titleBarOverlay = (zoom = 1) => ({
  color: "#00000000",
  symbolColor: nativeTheme.shouldUseDarkColors ? "#e6e6e6" : "#262626",
  height: Math.round(TITLEBAR_HEIGHT * zoom),
});

/** The traffic lights' frame is this tall; they sit this far in from the left, as in Finder. */
const TRAFFIC_LIGHTS_HEIGHT = 14;
const TRAFFIC_LIGHTS_INSET = 14;

/** Where the traffic lights go: centred on the titlebar at the window's zoom, so they line up with it. */
const trafficLightPosition = (zoom = 1) => ({
  x: TRAFFIC_LIGHTS_INSET,
  y: Math.round((TITLEBAR_HEIGHT * zoom - TRAFFIC_LIGHTS_HEIGHT) / 2),
});

/** Keeps the caption buttons in step with the window's zoom and the theme. */
const syncCaptionButtons = (window: BrowserWindow, zoom: number) => {
  if (mac) window.setWindowButtonPosition(trafficLightPosition(zoom));
  else window.setTitleBarOverlay(titleBarOverlay(zoom));
};

/**
 * The menu a desktop app needs, with the browser's keys left out: no Close (Ctrl+W closes a thread
 * tab), no Reload rows (a reload tears the whole UI down), no zoom items (the UI keeps the scale the
 * user picked and applies it through `cerium:set-zoom`, so Ctrl + and Ctrl − reach the page, and
 * Ctrl 0 opens a thread), and DevTools only while the app isn't packaged. macOS shows it in the menu
 * bar, so it leads with the app's own menu (About, Hide, Quit) in place of File, whose Close Window
 * would take ⌘W from the thread tabs, and keeps the Window menu's Zoom and Bring All to Front.
 */
const applicationMenu = () =>
  Menu.buildFromTemplate([
    mac ? { role: "appMenu" } : { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: app.isPackaged
        ? [{ role: "togglefullscreen" }]
        : [{ role: "toggleDevTools" }, { type: "separator" }, { role: "togglefullscreen" }],
    },
    // Minimized and shown from the taskbar as a family of apps does; no Close row beside it.
    {
      label: "Window",
      submenu: mac
        ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }]
        : [{ role: "minimize" }],
    },
  ]);

/**
 * Chromium in every app window: no navigation, no window of the page's own. A dropped file never
 * replaces the app (the composer's own drop handler takes files when it shows), a link never opens
 * inside it, and a reload stays on the same page it is on: nothing may move the shell elsewhere.
 */
app.on("web-contents-created", (_event, contents) => {
  // A preview's page keeps rules of its own (preview.ts).
  if (contents.getType() !== "window" || browserPreviews.owns(contents)) return;
  // Links open in the user's browser, never inside the app window.
  contents.setWindowOpenHandler(({ url }) => {
    if (opensExternally(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (url !== contents.getURL()) event.preventDefault();
  });
});

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    // On Windows and macOS the page paints nothing behind its surfaces, so the system's glass shows
    // through. Acrylic only reaches the page area of a transparent window (electron/electron#47510);
    // restoreNativeFrame puts back the resize frame and rounded corners Electron removes from those.
    // macOS puts Vibrancy behind an ordinary window, which keeps its frame and shadow, and dims it
    // while the window is in the background as its own apps do. Linux has no glass, so the page
    // paints its own backdrop and the window stays opaque, keeping its frame and shadow.
    ...(windows
      ? { transparent: true, backgroundMaterial: "acrylic" as const, backgroundColor: "#00000000" }
      : mac
        ? {
            vibrancy: "under-window" as const,
            visualEffectState: "followWindow" as const,
            backgroundColor: "#00000000",
          }
        : { backgroundColor: "#181818" }),
    titleBarStyle: "hidden",
    // On macOS this reports the traffic lights' corner to the page (Window Controls Overlay), which
    // keeps its titlebar clear of them.
    titleBarOverlay: titleBarOverlay(),
    ...(mac ? { trafficLightPosition: trafficLightPosition() } : {}),
    // The installed app takes its icon from its executable or bundle; this is for `bun run dev`,
    // which runs Electron's own, and for Linux, whose window managers ask the window. macOS's dock
    // takes it from the app instead (below).
    ...(devUrl === undefined && !linux ? {} : { icon: appIcon }),
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      // Under `bun run dev` the page keeps drawing behind other windows, so `bun run ui` driving it
      // gets frames, input and screenshots without bringing it over the user's work.
      backgroundThrottling: devUrl === undefined,
    },
  });

  if (windows) {
    void restoreNativeFrame(window);
    // Electron re-applies its own frame style on some state changes.
    const reapply = () => void restoreNativeFrame(window);
    window.on("maximize", reapply);
    window.on("unmaximize", reapply);
    window.on("restore", reapply);
  }
  // The window shows once the page has painted its launch screen in the user's theme, so it never
  // opens empty or in the other theme; a page that doesn't say so in time shows anyway.
  let shown = false;
  const showOnce = () => {
    if (shown || window.isDestroyed()) return;
    shown = true;
    if (!startHidden) window.show();
  };
  const onReady = (event: IpcMainEvent) => {
    if (event.sender === window.webContents) showOnce();
  };
  ipcMain.on("cerium:window-ready", onReady);
  window.once("ready-to-show", () => setTimeout(showOnce, WINDOW_READY_TIMEOUT_MS));
  window.on("close", (event) => {
    if (background.interceptClose()) event.preventDefault();
  });
  window.on("closed", () => {
    ipcMain.off("cerium:window-ready", onReady);
    browserPreviews.closeAll();
    mainWindow = undefined;
  });
  // A reload takes the panes away until the page lays them out again.
  window.webContents.on("did-start-loading", () => browserPreviews.unplaceAll());
  notifications.watch(window);
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

/** Whether Cerium starts when the user signs in to the computer; only the installed app can. */
ipcMain.handle("cerium:start-at-login", () => startAtLogin());
ipcMain.handle("cerium:set-start-at-login", (_event, enabled: unknown) =>
  typeof enabled === "boolean" ? setStartAtLogin(enabled) : startAtLogin(),
);

app.on("second-instance", () => background.show());
// Clicking the dock icon brings back a window hidden to the menu bar.
app.on("activate", () => background.show());

/** A toast about a thread, and the count of threads waiting over the taskbar icon (notifications.ts). */
ipcMain.on("cerium:notify", (_event, request: unknown) => {
  if (isNotificationRequest(request)) notifications.notify(request);
});
ipcMain.on("cerium:set-badge", (_event, request: unknown) => {
  if (isBadgeRequest(request)) notifications.setBadge(request);
});

/** Updating Cerium: the chosen channel, what it offers, and downloading and installing it. */
ipcMain.handle("cerium:updates", () => updater?.updates());
ipcMain.handle("cerium:check-for-updates", () => updater?.check());
ipcMain.handle("cerium:set-update-channel", (_event, channel: unknown) =>
  isUpdateChannel(channel) ? updater?.setChannel(channel) : updater?.updates(),
);
ipcMain.handle("cerium:download-update", () => updater?.download());
ipcMain.handle("cerium:install-update", () => updater?.install());

/** Where the UI connects to the backend this shell runs; nothing in development. */
ipcMain.handle("cerium:backend-connection", async () => {
  await backendStarting;
  return backend?.connection();
});

/** The folder a work thread runs in, chosen with the native dialog. */
ipcMain.handle("cerium:pick-folder", async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options = { properties: ["openDirectory" as const, "createDirectory" as const] };
  const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
});

/** Shows a file the transcript names in the file manager; only absolute paths, and nothing is opened. */
ipcMain.handle("cerium:reveal-path", (_event, target: unknown) => {
  if (typeof target === "string" && isAbsolute(target)) shell.showItemInFolder(normalize(target));
});

/**
 * Whether Windows' or macOS's privacy settings let Cerium use the microphone: Chromium reports a
 * block as a device that failed to start, or as silence, so dictation asks here what it meant. Linux
 * has no such setting.
 */
ipcMain.handle("cerium:microphone-access", () =>
  process.platform === "win32" || process.platform === "darwin"
    ? systemPreferences.getMediaAccessStatus("microphone")
    : "granted",
);

/** The system's microphone privacy page, for dictation the settings there block. */
ipcMain.handle("cerium:open-microphone-settings", async () => {
  if (windows) await shell.openExternal("ms-settings:privacy-microphone");
  if (mac) {
    await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
  }
});

/** Opens a file the explorer lists in its own app (openPath.ts). */
ipcMain.handle("cerium:open-path", (_event, target: unknown) => openPath(target));

/** Opens an artifact as a page of its own in the user's browser (openHtml.ts). */
ipcMain.handle("cerium:open-html", (_event, html: unknown, name: unknown) => openHtml(html, name));

/** Saves an image the transcript shows, where the user picks; resolves whether it was saved. */
ipcMain.handle("cerium:save-image", (event, source: unknown, name: unknown) =>
  saveImage(event.sender, source, name),
);

/** A command from the app-wide text menu, run on the right-click it was opened for. */
ipcMain.handle("cerium:text-command", (event, command: unknown) => runTextCommand(event.sender, command));

/**
 * The UI's theme choice. Windows tints Acrylic and macOS its Vibrancy from the native theme, and the
 * caption buttons follow it everywhere, so it follows the UI. Answers whether that means dark colours: after a forced theme,
 * the page's `prefers-color-scheme` doesn't return to the system's own when the choice goes back to
 * "system", so the UI asks here instead.
 */
ipcMain.handle("cerium:set-theme", (_event, theme: unknown) => {
  if (theme === "system" || theme === "dark" || theme === "light") nativeTheme.themeSource = theme;
  return nativeTheme.shouldUseDarkColors;
});

/** The scale the user picked in the UI, 1 being 100%; the page sends it before its window shows. */
ipcMain.on("cerium:set-zoom", (event, factor: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window === null || typeof factor !== "number" || !(factor >= 0.5 && factor <= 2)) return;
  event.sender.setZoomFactor(factor);
  syncCaptionButtons(window, factor);
});

// The system switching between light and dark, or the UI changing the theme.
nativeTheme.on("updated", () => {
  for (const window of BrowserWindow.getAllWindows()) {
    syncCaptionButtons(window, window.webContents.getZoomFactor());
    window.webContents.send("cerium:dark-colors", nativeTheme.shouldUseDarkColors);
  }
});

nameAppForNotifications();

/** Where the PATH the user's shell gave last time is kept, so a start needn't wait for the shell. */
const SHELL_PATH_FILE = "shell-path.txt";

/**
 * Starts the backend, which looks for the harnesses on the PATH a terminal would have (shellPath.ts).
 * Asking the user's shell for it can take seconds, and the window waits for the backend, so a start
 * after the first goes ahead on the PATH the shell gave last time, and a PATH it gives differently
 * now reaches the running backend once it's there.
 */
const launchBackend = async () => {
  if (process.platform === "win32") {
    backend = startBackend(process.env);
    return;
  }
  const env = sessionEnvironment();
  const file = join(app.getPath("userData"), SHELL_PATH_FILE);
  const remembered = rememberedPath(file);
  const asked = loginShellPath(env).then((path) => {
    if (path !== undefined && path !== remembered) void rememberPath(file, path);
    return path;
  });
  if (remembered === undefined) {
    backend = startBackend(withShellPath(env, await asked));
    return;
  }
  const started = startBackend(withShellPath(env, remembered));
  backend = started;
  void asked.then((path) => {
    if (path !== undefined && path !== remembered) started.setPath(withShellPath(env, path)["PATH"] ?? path);
  });
};

void app.whenReady().then(() => {
  if (devUrl === undefined) backendStarting = launchBackend();
  updater = startUpdater();
  // Chromium's built-in spellchecker is off: its squiggles are a website's, and the text menu
  // gets its groups from what a right-click was on now.
  session.defaultSession.setSpellCheckerEnabled(false);
  Menu.setApplicationMenu(applicationMenu());
  // Dark until the UI loads and reports the user's choice.
  nativeTheme.themeSource = "dark";
  // `bun run dev` on macOS runs Electron's own bundle, whose dock icon is Electron's.
  if (mac && devUrl !== undefined) app.dock?.setIcon(appIcon);
  createWindow();
  if (smokeTest !== undefined && mainWindow !== undefined) {
    runSmokeTest({
      folder: smokeTest,
      window: mainWindow,
      connection: async () => {
/** Saves a thread's export as Markdown or text, where the user picks; resolves whether it was saved. */
ipcMain.handle("cerium:save-text", (event, text: unknown, name: unknown, format: unknown) =>
  saveText(event.sender, text, name, format),
);

        await backendStarting;
        if (backend === undefined) throw new Error("no backend runs beside the UI dev server");
        return backend.connection();
      },
      stop: async () => backend?.stop(),
    });
  }
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
