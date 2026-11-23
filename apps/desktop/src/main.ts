import { NOTIFICATION_KINDS, type NotificationKind } from "@cerium/protocol";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  powerMonitor,
  screen,
  session,
  shell,
  systemPreferences,
  type IpcMainEvent,
  type Rectangle,
} from "electron";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";

import {
  backgroundMode,
  HIDDEN_FLAG,
  isKeepAwake,
  setStartAtLogin,
  startAtLogin,
  watchAttention,
} from "./background.ts";
import { startBackend, type BackendConnection } from "./backend.ts";
import { watchBackendActivity } from "./backendActivity.ts";
import type { BackendFailure } from "./backendFailure.ts";
import { asCrashReport } from "./crashReport.ts";
import { reportCrash, startCrashReports } from "./crashReports.ts";
import { desktopTheme } from "./desktopTheme.ts";
import { serveDictationRuntime } from "./dictationProtocol.ts";
import { cliState, installCli, refreshCli, removeCli } from "./cli.ts";
import { listEditors, openInEditor } from "./editors.ts";
import { launchArguments, parseLaunch, SCHEME, threadOfLink, type LaunchRequest } from "./launch.ts";
import { nameAppForNotifications, nativeNotifications } from "./notifications.ts";
import { openHtml } from "./openHtml.ts";
import { openPath } from "./openPath.ts";
import { previews } from "./preview.ts";
import { saveImage } from "./saveImage.ts";
import { saveText } from "./saveText.ts";
import {
  loginShellPath,
  rememberedPath,
  rememberPath,
  sessionEnvironment,
  withLocale,
  withShellPath,
} from "./shellPath.ts";
import { prepareSmokeTest, runSmokeTest } from "./smokeTest.ts";
import { forwardTextMenus, runTextCommand } from "./textMenu.ts";
import { isThreadId, isThreadMode, onScreen, threadWindows, type ThreadMode } from "./threadWindows.ts";
import { buildChannel, isUpdateChannel, startUpdater } from "./updater.ts";
import { restoreNativeFrame } from "./windowFrame.ts";

// The thin shell: a window with native caption buttons around the UI, Acrylic behind it on Windows
// and Vibrancy on macOS, the backend's launcher, and the tray that keeps a signed-in machine
// reachable (background.ts), the updater (updater.ts), the Preview pane's pages (preview.ts) and
// threads in windows of their own (threadWindows.ts). Everything else lives in the UI and the backend.

/** `--smoke-test` checks a packaged build runs, on a user-data folder of its own (smokeTest.ts). */
const smokeTest = prepareSmokeTest();

const uiDirectory = join(import.meta.dirname, "..", "..", "ui", "dist");
if (app.isPackaged) serveDictationRuntime(uiDirectory);

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

/** Anonymous crash reports, started before anything else can fail. */
const crashReports = startCrashReports(buildChannel());

let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
/** Settles once the packaged app's backend has started. */
let backendStarting: Promise<void> | undefined;
let updater: ReturnType<typeof startUpdater> | undefined;
let mainWindow: BrowserWindow | undefined;

const backendActivity = new AbortController();
let backendActivityEnded: Promise<void> = Promise.resolve();
const ACTIVITY_CLOSE_TIMEOUT_MS = 2_000;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Stops the backend once, for quitting and for restarting into an update alike. */
let backendStop: Promise<void> | undefined;
let backendStopped = false;
const stopBackend = (): Promise<void> => {
  backendActivity.abort();
  return (backendStop ??= Promise.race([backendActivityEnded, delay(ACTIVITY_CLOSE_TIMEOUT_MS)])
    .then(() => backend?.stop() ?? Promise.resolve())
    .then(() => {
      backendStopped = true;
    }));
};
/** Windows is signing the user out or shutting down, or a Mac is shutting down. */
let sessionEnding = false;

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

const showMainWindow = () => {
  if (quitting) return;
  const window = mainWindow;
  if (window === undefined) {
    if (hibernatedWindow !== undefined) createWindow(hibernatedWindow);
    return;
  }
  if (window === revealingWindow) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
};

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
  show: showMainWindow,
  onKeepAwakeChange: (mode) => mainWindow?.webContents.send("cerium:keep-awake", mode),
});

/** Where the threads open in windows of their own are remembered, so they come back next start. */
const THREAD_WINDOWS_FILE = "thread-windows.json";

/** Threads in windows of their own (threadWindows.ts), built once the app is ready. */
let threads: ReturnType<typeof threadWindows> | undefined;

const notifications = nativeNotifications({
  window: () => mainWindow,
  open: (threadId) => launch(threadId === undefined ? undefined : { kind: "thread", id: threadId }),
  threadWindow: (threadId) => threads?.windowOf(threadId),
});

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

/** What the menu bar and the Dock's menu ask the main window to do (preload.ts). */
type MenuCommand = "open-settings" | "new-thread";

/** Brings the main window forward, from the menu bar too, and has its page run `command`. */
const runMenuCommand = (command: MenuCommand) => {
  showMainWindow();
  sendWhenListening({ kind: "menu", command });
};

/**
 * The Mac's app menu and File menu. Settings and New Thread show the keys the page itself answers
 * (⌘, and ⌘N, lib/shortcuts.ts). The page hears a key first and takes it, so the menu's only act
 * when it didn't (the user rebound them in Cerium, say); those and a click ask the page through
 * `cerium:menu-command`. File holds no Close Window, which would take ⌘W from the thread tabs.
 */
const macMenus = (): Electron.MenuItemConstructorOptions[] => [
  {
    label: app.name,
    submenu: [
      { role: "about" },
      { type: "separator" },
      {
        label: "Settings…",
        accelerator: "Command+,",
        registerAccelerator: false,
        click: () => runMenuCommand("open-settings"),
      },
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  },
  {
    label: "File",
    submenu: [
      {
        label: "New Thread",
        accelerator: "Command+N",
        registerAccelerator: false,
        click: () => runMenuCommand("new-thread"),
      },
    ],
  },
];

/**
 * The menu a desktop app needs, with the browser's keys left out: no Close (Ctrl+W closes a thread
 * tab), no Reload rows (a reload tears the whole UI down), no zoom items (the UI keeps the scale the
 * user picked and applies it through `cerium:set-zoom`, so Ctrl + and Ctrl − reach the page, and
 * Ctrl 0 opens a thread), and DevTools only while the app isn't packaged. macOS shows it in the menu
 * bar, so it leads with the app's own menu (About, Settings, Hide, Quit) and a File menu of its own
 * (macMenus), and keeps the Window menu's Zoom and Bring All to Front.
 */
const applicationMenu = () =>
  Menu.buildFromTemplate([
    ...(mac ? macMenus() : [{ role: "fileMenu" } as const]),
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

/**
 * A window of the app's, the main one or a thread's own: the glass, frame and caption buttons each
 * has, its text menu, and showing once its page has painted. `appear` says how it shows then: in
 * front, behind the window in front (one reopened at start), or not until asked (a start at login).
 */
const appWindow = ({
  size,
  appear,
}: {
  size: Pick<Rectangle, "width" | "height"> & Partial<Pick<Rectangle, "x" | "y">>;
  appear: "front" | "behind" | "hidden";
}) => {
  const window = new BrowserWindow({
    ...size,
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
    if (appear === "front") window.show();
    else if (appear === "behind") window.showInactive();
  };
  const onReady = (event: IpcMainEvent) => {
    if (event.sender === window.webContents) showOnce();
  };
  ipcMain.on("cerium:window-ready", onReady);
  window.once("ready-to-show", () => setTimeout(showOnce, WINDOW_READY_TIMEOUT_MS));
  window.on("closed", () => ipcMain.off("cerium:window-ready", onReady));
  // In full screen macOS hides the traffic lights and stops reporting their corner (Window Controls
  // Overlay), so the page's titlebar would keep a gap for them; it hears so and starts at the edge.
  if (mac) {
    const sendFullScreen = () => {
      if (!window.isDestroyed()) window.webContents.send("cerium:full-screen", window.isFullScreen());
    };
    window.on("enter-full-screen", sendFullScreen);
    window.on("leave-full-screen", sendFullScreen);
    // A reload in full screen starts the page over, without the attribute.
    window.webContents.on("did-finish-load", () => {
      if (window.isFullScreen()) sendFullScreen();
    });
  }
  forwardTextMenus(window.webContents);
  return window;
};

/** Loads the UI into `window`: a thread's own window names its thread and mode in the address. */
const loadPage = (window: BrowserWindow, thread?: { threadId: string; mode: ThreadMode }) => {
  // Not `thread`, which a tapped notification's address uses (apps/ui/src/web/push.ts).
  const query = thread ? { window: thread.threadId, mode: thread.mode } : undefined;
  if (devUrl === undefined) {
    const page = join(uiDirectory, "index.html");
    void window.loadFile(page, query ? { query } : {});
  } else {
    const url = new URL(devUrl);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    void window.loadURL(url.toString());
  }
};

/** Cerium is quitting, which closes every window: a thread's own comes back next start. */
let quitting = false;
app.on("before-quit", () => {
  quitting = true;
  clearTimeout(hibernateTimer);
  backendActivity.abort();
  threads?.quit();
  browserPreviews.closeAll();
});

/** A tray window stays warm for quick returns before releasing its renderer. */
const HIBERNATE_AFTER_MS = 5 * 60_000;
const HIBERNATE_RETRY_MS = 30_000;
interface HibernatedWindow {
  readonly bounds: Rectangle;
  readonly maximized: boolean;
  readonly fullScreen: boolean;
}
let hibernateTimer: ReturnType<typeof setTimeout> | undefined;
let hibernatedWindow: HibernatedWindow | undefined;
let revealingWindow: BrowserWindow | undefined;
let rendererBusy = false;
let restoredThreadWindows = false;

const scheduleHibernation = (window: BrowserWindow, delay = HIBERNATE_AFTER_MS) => {
  clearTimeout(hibernateTimer);
  if (
    smokeTest !== undefined ||
    quitting ||
    background.attached() ||
    !background.signedIn() ||
    window.isDestroyed() ||
    window.isVisible() ||
    window.isMinimized()
  )
    return;

  hibernateTimer = setTimeout(() => {
    if (
      quitting ||
      sessionEnding ||
      background.attached() ||
      !background.signedIn() ||
      window !== mainWindow ||
      window.isVisible() ||
      window.isMinimized()
    )
      return;
    const contents = window.webContents;
    if (rendererBusy || contents.isDevToolsOpened() || contents.isCurrentlyAudible() || !launchListening) {
      scheduleHibernation(window, HIBERNATE_RETRY_MS);
      return;
    }
    hibernatedWindow = {
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
      fullScreen: window.isFullScreen(),
    };
    launchListening = false;
    notifications.view(undefined);
    mainWindow = undefined;
    browserPreviews.syncPlacement();
    window.destroy();
  }, delay);
};

const createWindow = (restored?: HibernatedWindow) => {
  const bounds = restored?.bounds;
  const window = appWindow({
    size:
      bounds !== undefined &&
      onScreen(
        bounds,
        screen.getAllDisplays().map((display) => display.workArea),
      )
        ? bounds
        : { width: 1280, height: 820 },
    appear: restored === undefined && startHidden ? "hidden" : "front",
  });
  mainWindow = window;
  if (restored !== undefined) revealingWindow = window;
  hibernatedWindow = undefined;
  window.on("hide", () => {
    browserPreviews.syncPlacement();
    scheduleHibernation(window);
  });
  window.on("show", () => {
    clearTimeout(hibernateTimer);
    browserPreviews.syncPlacement();
    notifications.syncBadge();
  });
  notifications.watch(window);
  window.setMinimumSize(960, 600);
  window.on("close", (event) => {
    if (background.interceptClose()) event.preventDefault();
  });
  window.on("session-end", () => {
    sessionEnding = true;
  });
  window.on("closed", () => {
    if (window !== mainWindow) return; // Hibernation already released this window.
    clearTimeout(hibernateTimer);
    mainWindow = undefined;
    // The threads' own windows go with the main one, and come back with it next start.
    if (!quitting) app.quit();
  });
  // A reload takes the panes away until the page lays them out again, and the page stops listening
  // for what Cerium was asked to open until it says so again.
  window.webContents.on("did-start-loading", () => {
    browserPreviews.unplaceAll();
    launchListening = false;
    rendererBusy = false;
    notifications.view(undefined);
  });
  // The threads left in windows of their own last time come back once the main window shows, which
  // a start at login holds back until it's asked for.
  window.once("show", () => {
    revealingWindow = undefined;
    if (restored?.maximized) window.maximize();
    if (restored?.fullScreen) window.setFullScreen(true);
    if (!restoredThreadWindows) {
      restoredThreadWindows = true;
      threads?.restore();
    }
  });
  loadPage(window);
};

/** A thread's own window: smaller than the main one, never so narrow that it turns phone-like. */
const createThreadWindow = ({
  threadId,
  mode,
  bounds,
  restored,
}: {
  threadId: string;
  mode: ThreadMode;
  bounds?: Rectangle;
  restored: boolean;
}) => {
  const window = appWindow({
    size: bounds ?? { width: 960, height: 780 },
    appear: restored ? "behind" : "front",
  });
  window.setMinimumSize(800, 480);
  notifications.watch(window, threadId);
  loadPage(window, { threadId, mode });
  return window;
};

/** Whether the main window sent `event`, rather than a thread's own. */
const fromMainWindow = (event: IpcMainEvent) => event.sender === mainWindow?.webContents;

/** Opens a thread in a window of its own, or brings its window forward. */
ipcMain.on("cerium:open-thread-window", (event, threadId: unknown, mode: unknown) => {
  if (!fromMainWindow(event) || !isThreadId(threadId) || !isThreadMode(mode)) return;
  threads?.open(threadId, mode);
});

/** Keep the main window's tab state across hibernation, in memory for this app launch only. */
const tabState = new Map<string, string>();
ipcMain.on("cerium:remember-tab-state", (event, key: unknown, value: unknown) => {
  if (fromMainWindow(event) && typeof key === "string" && typeof value === "string") tabState.set(key, value);
});
ipcMain.on("cerium:tab-state", (event, key: unknown) => {
  event.returnValue = fromMainWindow(event) && typeof key === "string" ? (tabState.get(key) ?? null) : null;
});
ipcMain.on("cerium:renderer-busy", (event, busy: unknown) => {
  if (fromMainWindow(event) && typeof busy === "boolean") rendererBusy = busy;
});

/** Whether Cerium starts when the user signs in to the computer; only the installed app can. */
ipcMain.handle("cerium:start-at-login", () => startAtLogin());
ipcMain.handle("cerium:set-start-at-login", (_event, enabled: unknown) =>
  typeof enabled === "boolean" ? setStartAtLogin(enabled) : startAtLogin(),
);

/** When a signed-in machine is kept from sleeping, so the user's other devices can reach it (background.ts). */
ipcMain.handle("cerium:keep-awake", () => background.keepAwake());
ipcMain.handle("cerium:set-keep-awake", (_event, mode: unknown) =>
  isKeepAwake(mode) ? background.setKeepAwake(mode) : background.keepAwake(),
);

/** Whether the user is at Cerium: a window of it has focus and they're active (background.ts). */
let attention: ReturnType<typeof watchAttention> | undefined;
ipcMain.handle("cerium:attended", () => attention?.attended() ?? true);

/**
 * What the user asked Cerium to open, by the command (`cerium .`) or a link (`cerium://thread/<id>`):
 * the page takes it once it has said it listens (`cerium:launch-ready`), and until then, or while it
 * reloads, it waits here. A thread open in a window of its own is brought forward instead.
 */
type WindowRequest =
  | LaunchRequest
  | { readonly kind: "menu"; readonly command: MenuCommand }
  | { readonly kind: "preview"; readonly id: string };
const pendingLaunches: WindowRequest[] = [];
let launchListening = false;

const deliverLaunches = () => {
  const target = mainWindow?.webContents;
  if (!launchListening || target === undefined || target.isDestroyed()) return;
  for (const request of pendingLaunches.splice(0)) target.send("cerium:launch", request);
};

const sendWhenListening = (request: WindowRequest) => {
  if (
    request.kind === "preview" &&
    pendingLaunches.some((each) => each.kind === "preview" && each.id === request.id)
  )
    return;
  pendingLaunches.push(request);
  deliverLaunches();
};

const launch = (request: LaunchRequest | undefined) => {
  if (smokeTest !== undefined) return;
  if (request?.kind === "thread") {
    const own = threads?.windowOf(request.id);
    if (own !== undefined) {
      if (own.isMinimized()) own.restore();
      own.show();
      own.focus();
      return;
    }
  }
  showMainWindow();
  if (request !== undefined) sendWhenListening(request);
};

/** A second start's command line or link, handed to the instance that is running. */
app.on("second-instance", (_event, argv, cwd) =>
  launch(parseLaunch(launchArguments(argv, app.isPackaged), cwd)),
);
// macOS hands links to the running app as an event, never as an argument.
app.on("open-url", (event, url) => {
  event.preventDefault();
  const id = threadOfLink(url);
  launch(id === undefined ? undefined : { kind: "thread", id });
});
// The page listens: what asked for something before that, or while it reloaded, goes to it now.
ipcMain.on("cerium:launch-ready", (event) => {
  if (!fromMainWindow(event)) return;
  launchListening = true;
  deliverLaunches();
});
// Clicking the dock icon brings back a window hidden to the menu bar.
app.on("activate", showMainWindow);

ipcMain.on("cerium:notification-preferences", (event, value: unknown) => {
  if (!fromMainWindow(event) || typeof value !== "object" || value === null) return;
  const { kinds, silent, badge } = value as Record<string, unknown>;
  if (!Array.isArray(kinds) || typeof silent !== "boolean" || typeof badge !== "boolean") return;
  notifications.configure({
    kinds: kinds.filter((kind): kind is NotificationKind => NOTIFICATION_KINDS.includes(kind)),
    silent,
    badge,
  });
});
ipcMain.on("cerium:notification-viewing", (event, threadId: unknown) => {
  if (fromMainWindow(event)) notifications.view(isThreadId(threadId) ? threadId : undefined);
});
ipcMain.on("cerium:test-notification", (event, silent: unknown) => {
  if (fromMainWindow(event) && typeof silent === "boolean") notifications.test(silent);
});
ipcMain.on("cerium:notification-badge-icons", (event, icons: unknown) => {
  if (process.platform !== "win32" || !fromMainWindow(event) || !Array.isArray(icons) || icons.length !== 10)
    return;
  if (icons.every((icon) => typeof icon === "string" && icon.startsWith("data:image/png;base64,")))
    notifications.setBadgeIcons(icons);
});

/** Updating Cerium: the chosen channel, what it offers, and downloading and installing it. */
ipcMain.handle("cerium:updates", () => updater?.updates());
ipcMain.handle("cerium:check-for-updates", () => updater?.check());
ipcMain.handle("cerium:set-update-channel", (_event, channel: unknown) =>
  isUpdateChannel(channel) ? updater?.setChannel(channel) : updater?.updates(),
);
ipcMain.handle("cerium:set-auto-download", (_event, on: unknown) =>
  typeof on === "boolean" ? updater?.setAutoDownload(on) : updater?.updates(),
);
ipcMain.handle("cerium:download-update", () => updater?.download());
ipcMain.handle(
  "cerium:install-update",
  (_event, anyway: unknown) => updater?.install(anyway === true) ?? "unavailable",
);

/** Where the UI connects to the backend this shell runs; nothing in development. */
ipcMain.handle("cerium:backend-connection", async () => {
  await backendStarting;
  return backend?.connection();
});

/** Why the backend last stopped, while none listens since; the UI also hears each change. */
ipcMain.handle("cerium:backend-failure", async () => {
  await backendStarting;
  return backend?.failure();
});
ipcMain.handle("cerium:restart-backend", async () => {
  await backendStarting;
  backend?.restart();
});
ipcMain.handle("cerium:start-host-service", async () => {
  await backendStarting;
  await backend?.startHostService();
});
ipcMain.handle("cerium:update-host", async () => {
  await backendStarting;
  await backend?.updateHost();
});
ipcMain.handle("cerium:use-local-backend", async () => {
  await backendStarting;
  backend?.useLocalBackend();
});
/** Whether this build sends crash reports, and the user's switch for them. */
ipcMain.handle("cerium:crash-reports", () => crashReports.state());
ipcMain.handle("cerium:set-crash-reports", (_event, enabled: unknown) =>
  typeof enabled === "boolean" ? crashReports.setEnabled(enabled) : crashReports.state(),
);
/** A failure Cerium's own windows report; preview pages get no preload to send one. */
ipcMain.on("cerium:report-crash", (event, report: unknown) => {
  if (BrowserWindow.fromWebContents(event.sender) === null) return;
  const valid = asCrashReport(report, "renderer");
  if (valid !== undefined) reportCrash(valid);
});
/** The folder with the backend's and the updater's logs, in the file manager. */
ipcMain.handle("cerium:open-logs", async () => {
  await shell.openPath(app.getPath("logs"));
});

/** Open the packaged reader, or Electron's original notices when running from source. */
ipcMain.handle("cerium:open-chromium-notices", async () => {
  const folder = app.isPackaged
    ? process.resourcesPath
    : join(dirname(process.execPath), mac ? "../../.." : ".");
  const error = await shell.openPath(join(folder, "LICENSES.chromium.html"));
  if (error) throw new Error(error);
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

/**
 * Asks macOS for the microphone before dictation first opens it, with the system's own prompt
 * (NSMicrophoneUsageDescription, electron-builder.ts): opened without asking, the first recording
 * can start while the prompt still shows and hear nothing. Answers the access the system then gives;
 * once the user has answered, it only reports it. Only the Mac's preload offers it.
 */
ipcMain.handle("cerium:request-microphone-access", async () => {
  if (!mac) return "granted";
  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status !== "not-determined") return status;
  return (await systemPreferences.askForMediaAccess("microphone")) ? "granted" : "denied";
});

/** The system's microphone privacy page, for dictation the settings there block. */
ipcMain.handle("cerium:open-microphone-settings", async () => {
  if (windows) await shell.openExternal("ms-settings:privacy-microphone");
  if (mac) {
    await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
  }
});

/** Opens a file the explorer lists in its own app (openPath.ts). */
ipcMain.handle("cerium:open-path", (_event, target: unknown) => openPath(target));

/** The `cerium` command: whether it's on this computer's PATH, and putting it there or taking it off (cli.ts). */
const shellPathNow = () => (windows ? Promise.resolve(undefined) : loginShellPath(sessionEnvironment()));
ipcMain.handle("cerium:cli", () => cliState(app.isPackaged, shellPathNow));
ipcMain.handle("cerium:install-cli", async () => {
  if (app.isPackaged) await installCli(shellPathNow);
  return cliState(app.isPackaged, shellPathNow);
});
ipcMain.handle("cerium:remove-cli", async () => {
  if (app.isPackaged) await removeCli();
  return cliState(app.isPackaged, shellPathNow);
});

/** The editors installed here, and opening a file in one at a line (editors.ts). */
ipcMain.handle("cerium:editors", (_event, fresh: unknown) => listEditors(fresh === true));
ipcMain.handle(
  "cerium:open-in-editor",
  (_event, id: unknown, file: unknown, line: unknown, folder: unknown) =>
    openInEditor(id, file, line, folder),
);

/** Opens an artifact as a page of its own in the user's browser (openHtml.ts). */
ipcMain.handle("cerium:open-html", (_event, html: unknown, name: unknown) => openHtml(html, name));

/** Saves an image the transcript shows, where the user picks; resolves whether it was saved. */
ipcMain.handle("cerium:save-image", (event, source: unknown, name: unknown) =>
  saveImage(event.sender, source, name),
);

/** Saves a thread's export as Markdown or text, where the user picks; resolves whether it was saved. */
ipcMain.handle("cerium:save-text", (event, text: unknown, name: unknown, format: unknown) =>
  saveText(event.sender, text, name, format),
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

const desktop = desktopTheme();

/** The colours the Desktop theme takes from the system's accent and the wallpaper (desktopTheme.ts). */
ipcMain.handle("cerium:desktop-colors", () => desktop.colors());

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
const launchBackend = async (update: ReturnType<typeof startUpdater>["remote"]) => {
  const options = { disableAttach: smokeTest !== undefined };
  if (process.platform === "win32") {
    backend = await startBackend(process.env, update, options);
    return;
  }
  const env = mac
    ? withLocale(sessionEnvironment(), app.getSystemLocale(), (name) =>
        existsSync(join("/usr/share/locale", name)),
      )
    : sessionEnvironment();
  const file = join(app.getPath("userData"), SHELL_PATH_FILE);
  const remembered = rememberedPath(file);
  const asked = loginShellPath(env).then((path) => {
    if (path !== undefined && path !== remembered) void rememberPath(file, path);
    return path;
  });
  const initialEnv =
    remembered !== undefined ? withShellPath(env, remembered) : withShellPath(env, await asked);
  const started = await startBackend(initialEnv, update, options);
  backend = started;
  if (remembered !== undefined) {
    void asked.then((path) => {
      if (path !== undefined && path !== remembered)
        started.setPath(withShellPath(env, path)["PATH"] ?? path);
    });
  }
};

const activityConnection = async (): Promise<BackendConnection> => {
  if (devUrl !== undefined) {
    const response = await fetch(new URL("/__cerium/connection", devUrl), {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) return (await response.json()) as BackendConnection;
  } else {
    await backendStarting;
    if (backend !== undefined) return backend.connection();
  }
  throw new Error("Cerium's local backend isn't listening yet.");
};

let heardPresence = false;
void app.whenReady().then(() => {
  updater = startUpdater({
    working: () => !backend?.attached() && background.working(),
    stopBackend,
    changed: (state) => backend?.publishUpdate(state),
  });
  if (devUrl === undefined) {
    backendStarting = launchBackend(updater.remote);
    void backendStarting.then(() => {
      const current = backend;
      if (current === undefined) return;
      background.setAttached(current.attached());
      if (current.attached() && startHidden) showMainWindow();
      current.onAttachedChange((attached) => background.setAttached(attached));
      const publishFailure = (failure: BackendFailure | undefined) => {
        if (failure !== undefined) background.setWorking(false);
        for (const window of BrowserWindow.getAllWindows())
          window.webContents.send("cerium:backend-failure", failure);
      };
      current.onFailure(publishFailure);
      const initialFailure = current.failure();
      if (initialFailure !== undefined) publishFailure(initialFailure);
    });
  }
  attention = watchAttention((attended) => mainWindow?.webContents.send("cerium:attended", attended));
  // A Mac shutting down would stop the update helper partway too (installOnExit).
  if (mac) {
    powerMonitor.on("shutdown", () => {
      sessionEnding = true;
    });
  }
  // Links open Cerium: this computer's own installed app takes them, never a development build that
  // would claim them from it. An installed command follows the app if an update moved it.
  if (app.isPackaged && smokeTest === undefined) {
    app.setAsDefaultProtocolClient(SCHEME);
    void refreshCli().catch(() => undefined);
  }
  // Chromium's built-in spellchecker is off: its squiggles are a website's, and the text menu
  // gets its groups from what a right-click was on now.
  session.defaultSession.setSpellCheckerEnabled(false);
  Menu.setApplicationMenu(applicationMenu());
  // Dark until the UI loads and reports the user's choice.
  nativeTheme.themeSource = "dark";
  // `bun run dev` on macOS runs Electron's own bundle, whose dock icon is Electron's.
  if (mac && devUrl !== undefined) app.dock?.setIcon(appIcon);
  if (mac) {
    // A right-click on the Dock icon starts a thread, from the menu bar's hidden window too.
    app.dock?.setMenu(
      Menu.buildFromTemplate([{ label: "New Thread", click: () => runMenuCommand("new-thread") }]),
    );
  }
  threads = threadWindows({
    file: join(app.getPath("userData"), THREAD_WINDOWS_FILE),
    create: createThreadWindow,
    screens: () => screen.getAllDisplays().map((display) => display.workArea),
  });
  createWindow();
  backendActivityEnded = watchBackendActivity({
    signal: backendActivity.signal,
    connection: activityConnection,
    signedIn: (signedIn) => {
      const wasSignedIn = background.signedIn();
      background.setSignedIn(signedIn);
      if (signedIn && !wasSignedIn && mainWindow !== undefined) scheduleHibernation(mainWindow);
      if (!signedIn) {
        clearTimeout(hibernateTimer);
        if ((startHidden && !heardPresence) || (wasSignedIn && !mainWindow?.isVisible())) showMainWindow();
      }
      heardPresence = true;
    },
    working: background.setWorking,
    notify: notifications.notify,
    previews: browserPreviews.updateThreads,
    browser: async ({ threadId, command }) => {
      const outcome = await browserPreviews.answer(threadId, command);
      if (command._tag === "Open" && outcome._tag === "Done")
        sendWhenListening({ kind: "preview", id: threadId });
      return outcome;
    },
  });
  // The command or link that started this instance asks for something too.
  const asked = parseLaunch(launchArguments(process.argv, app.isPackaged), process.cwd());
  if (asked !== undefined) launch(asked);
  if (smokeTest !== undefined && mainWindow !== undefined) {
    runSmokeTest({
      folder: smokeTest,
      window: mainWindow,
      connection: async () => {
        await backendStarting;
        if (backend === undefined) throw new Error("no backend runs beside the UI dev server");
        return backend.connection();
      },
      stop: stopBackend,
    });
  }
  if (startHidden) {
    setTimeout(() => {
      if (!heardPresence) showMainWindow();
    }, HIDDEN_START_TIMEOUT_MS);
  }
});

app.on("window-all-closed", () => {
  if (hibernatedWindow === undefined && !quitting) app.quit();
});

// Quitting waits for the backend to shut down, so it closes its harness sessions and database. On
// Windows and for ad hoc Mac builds, the downloaded update's installer starts then (updater.ts),
// unless the system is shutting down, which would stop it partway: the update installs another time.
app.on("will-quit", (event) => {
  if (backend !== undefined && !backendStopped) {
    event.preventDefault();
    // Quitting again waits for this quit to be over: Electron drops one asked for while it's still
    // under way, as a stop that had already finished would ask.
    void stopBackend().then(() => setImmediate(() => app.quit()));
    return;
  }
  if (!sessionEnding) updater?.installOnExit();
});
