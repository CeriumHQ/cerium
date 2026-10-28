import { drivenMachine } from "./machine.ts";

/** Where the UI reaches the backend. */
export interface BackendConnection {
  readonly url: string;
  readonly token: string;
}

/**
 * A right-click no page menu claimed, as the app-wide text menu needs it. The shell keeps the rest
 * (the selected text, the link) and acts on it when the page names a command.
 */
export interface TextMenuRequest {
  /** Where, in the window's CSS pixels. */
  readonly x: number;
  readonly y: number;
  readonly editable: boolean;
  readonly canCut: boolean;
  readonly canCopy: boolean;
  readonly canPaste: boolean;
  readonly canSelectAll: boolean;
  /** Some text is selected. */
  readonly selection: boolean;
  /** A link was right-clicked; only `https` links open. */
  readonly link?: { readonly openable: boolean };
}

/** What the text menu asks the shell to do with the right-click it last reported. */
export type TextCommand = {
  readonly kind: "cut" | "copy" | "paste" | "selectAll" | "copySelection" | "openLink" | "copyLink";
};

/** What Electron's preload exposes as `window.cerium`; absent in the browser preview. */
export interface ShellBridge {
  readonly shell: "electron";
  readonly platform: string;
  /**
   * Where the shell's own backend listens, once it does; asked on every connect, since a restarted
   * backend has a new port and token. Undefined in development, where the UI asks the dev server.
   */
  readonly backendConnection?: () => Promise<BackendConnection | undefined>;
  /** Why the shell's backend last stopped, while none listens since (`BackendFailure`). */
  readonly backendFailure?: () => Promise<unknown>;
  /** Calls back whenever the backend stops on a failure, or listens again (undefined); returns how to stop. */
  readonly onBackendFailure?: (listener: (failure: unknown) => void) => () => void;
  /** Starts a stopped backend now instead of after its back-off. */
  readonly restartBackend?: () => Promise<void>;
  /** Opens the folder of Cerium's logs in the system's file manager. */
  readonly openLogs?: () => Promise<void>;
  /** Whether this build sends anonymous crash reports, and whether the user lets it (`CrashReportsState`). */
  readonly crashReports?: () => Promise<CrashReportsState>;
  readonly setCrashReports?: (enabled: boolean) => Promise<CrashReportsState>;
  /** Hands the shell a failure to report, which it scrubs and sends as the user allows. */
  readonly reportCrash?: (report: UiCrashReport) => void;
  readonly pickFolder?: () => Promise<string | undefined>;
  /** Where a pasted or dropped file lives on disk; undefined for one that only exists in memory. */
  readonly pathForFile?: (file: File) => string | undefined;
  /** Shows a file or folder (absolute path) in the system's file manager. */
  readonly revealPath?: (path: string) => Promise<void>;
  /**
   * Opens a file (absolute path) in the app the system gives its kind. A program or script isn't run:
   * its folder opens with it selected.
   */
  readonly openPath?: (path: string) => Promise<void>;
  /**
   * Saves an image where the user picks with the native Save dialog, suggesting `name`. `source` is
   * a `data:image/…;base64,` URL or an absolute path to an image file. Resolves whether it was saved.
   */
  readonly saveImage?: (source: string, name: string) => Promise<boolean>;
  /**
   * Saves `text` where the user picks with the native Save dialog, suggesting `name`; `format` picks the
   * file types offered. Resolves whether it was saved.
   */
  readonly saveText?: (text: string, name: string, format: "markdown" | "text") => Promise<boolean>;
  /** Opens `html`, a page of its own, in the user's browser, from a file named after `name`. */
  readonly openHtml?: (html: string, name: string) => Promise<void>;
  /**
   * The system draws the window's caption buttons, and tints its Acrylic on Windows and Vibrancy on
   * macOS, in this theme.
   * Resolves whether that means dark colours, which for "system" is the system's own choice.
   */
  readonly setTheme?: (theme: "system" | "dark" | "light") => Promise<boolean>;
  /** Calls back whenever the system's colours turn dark or light; returns how to stop. */
  readonly onDarkColorsChange?: (listener: (dark: boolean) => void) => () => void;
  /** Scales the whole window by `factor` (1 is 100%), caption buttons included. */
  readonly setZoom?: (factor: number) => void;
  /** The launch screen has painted in the user's theme, so the shell may show the window. */
  readonly windowReady?: () => void;
  /** Calls back on every right-click no page menu claimed; returns how to stop. */
  readonly onTextMenu?: (listener: (request: TextMenuRequest) => void) => () => void;
  /** Runs a text menu command on the last right-click, in the focused field or frame. */
  readonly runTextCommand?: (command: TextCommand) => Promise<void>;
  /**
   * Whether this machine is signed in to a Cerium account and whether agents are working: signed in,
   * closing the window hides it to the tray, and working too, the PC is kept awake.
   */
  readonly setPresence?: (presence: { signedIn: boolean; working: boolean }) => void;
  /**
   * Whether Cerium starts when the user signs in to the computer; only the installed app can: on
   * Linux the AppImage or the .deb or .rpm package.
   */
  readonly startAtLogin?: () => Promise<StartAtLogin>;
  readonly setStartAtLogin?: (enabled: boolean) => Promise<StartAtLogin>;
  /** The update channel the user follows and what it offers (apps/desktop/src/updater.ts). */
  readonly updates?: () => Promise<Updates>;
  readonly checkForUpdates?: () => Promise<Updates>;
  /** Follows another channel and checks it at once. */
  readonly setUpdateChannel?: (channel: UpdateChannel) => Promise<Updates>;
  /** Whether updates download as soon as a check finds them. */
  readonly setAutoDownload?: (on: boolean) => Promise<Updates>;
  /** Downloads the update a check found; progress arrives through `onUpdatesChange`. */
  readonly downloadUpdate?: () => Promise<void>;
  /**
   * Quits, installs the downloaded update and starts it, unless agents are working and not
   * `anyway`: then nothing happens and it says `working`.
   */
  readonly installUpdate?: (anyway?: boolean) => Promise<InstallResult>;
  /** Calls back whenever what the updater knows changes; returns how to stop. */
  readonly onUpdatesChange?: (listener: (updates: Updates) => void) => () => void;
  /**
   * Shows a native notification about a thread, with the system's sound unless `silent`; `attention`
   * also flashes the taskbar button until the window is focused.
   */
  readonly notify?: (request: NativeNotification) => void;
  /** The number over the taskbar icon, drawn in `icon` (a PNG data URL); 0 clears it. */
  readonly setBadge?: (badge: { count: number; icon?: string }) => void;
  /** Calls back with the thread of each clicked notification; returns how to stop. */
  readonly onOpenThread?: (listener: (threadId: string) => void) => () => void;
  /**
   * Opens one of this computer's threads in a window of its own, or brings forward the one it has;
   * only the main window asks (apps/desktop/src/threadWindows.ts).
   */
  readonly openThreadWindow?: (threadId: string, mode: "work" | "chat") => void;
  /** The Preview pane's pages, which the shell lays over the window (apps/desktop/src/preview.ts). */
  readonly preview?: PreviewBridge;
  /** Whether the system's privacy settings let Cerium use the microphone: `denied` when they block it. */
  readonly microphoneAccess?: () => Promise<string>;
  /**
   * Opens Windows' or macOS's microphone privacy settings, where dictation's access is turned back
   * on; absent on Linux, which has no such page.
   */
  readonly openMicrophoneSettings?: () => Promise<void>;
}

/** Mirrors the shell's `PreviewState` in apps/desktop/src/preview.ts. */
export interface PreviewState {
  readonly threadId: string;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly error?: string;
}

/** A box in the window's CSS pixels. */
export interface PreviewBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Each thread's preview page, kept by the shell; the pane says where to lay it and drives it. */
export interface PreviewBridge {
  /** Runs an agent's browser call on the thread's page, opening one if it has none. */
  readonly run: (threadId: string, command: unknown) => Promise<unknown>;
  /** Lays the page over `bounds`, or takes it away (`null`), opening one first if it has none. */
  readonly place: (threadId: string, bounds: PreviewBounds | null) => void;
  /** Opens what the user typed; resolves false for an address the preview won't open. */
  readonly navigate: (threadId: string, input: string) => Promise<boolean>;
  readonly go: (threadId: string, go: "back" | "forward" | "reload" | "stop") => void;
  /** Closes the thread's page. */
  readonly close: (threadId: string) => void;
  /** What the page shows now, as a PNG data URL. */
  readonly still: (threadId: string) => Promise<string | undefined>;
  /** Every page open now. */
  readonly states: () => Promise<unknown>;
  readonly onState: (listener: (state: unknown) => void) => () => void;
  readonly onClosed: (listener: (threadId: string) => void) => () => void;
}

/** Mirrors the shell's `NotificationRequest` in apps/desktop/src/notifications.ts. */
export interface NativeNotification {
  readonly threadId: string;
  readonly title: string;
  readonly body: string;
  readonly silent: boolean;
  readonly attention: boolean;
}

export interface StartAtLogin {
  readonly available: boolean;
  readonly enabled: boolean;
}

/** Mirrors the shell's own type in apps/desktop/src/crashReports.ts. */
export interface CrashReportsState {
  /** This build sends reports at all: a packaged release. */
  readonly available: boolean;
  readonly enabled: boolean;
}

/** A failure in the UI, as the shell's `asCrashReport` (apps/desktop/src/crashReport.ts) takes it. */
export interface UiCrashReport {
  readonly category: "render" | "uncaught";
  readonly kind?: string;
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

export type UpdateChannel = "stable" | "nightly";

/** Mirrors the shell's own type in apps/desktop/src/updater.ts. */
export type UpdateStatus =
  /** A development build: only the installed app updates. */
  | { readonly kind: "unsupported" }
  | { readonly kind: "checking" }
  | { readonly kind: "current"; readonly checkedAt: number }
  | { readonly kind: "available"; readonly version: string }
  | { readonly kind: "downloading"; readonly version: string; readonly percent: number }
  | { readonly kind: "ready"; readonly version: string }
  /** Cerium is closing to restart into the downloaded update. */
  | { readonly kind: "installing"; readonly version: string }
  /** The releases couldn't be read: `offline`, or `unpublished` when the channel has none to read. */
  | { readonly kind: "unreachable"; readonly reason: "offline" | "unpublished"; readonly checkedAt: number }
  | { readonly kind: "failed"; readonly version: string };

export interface Updates {
  readonly channel: UpdateChannel;
  /** The running build's version and channel. */
  readonly version: string;
  readonly buildChannel: UpdateChannel;
  readonly status: UpdateStatus;
  /** This build can't install updates itself: downloading one opens it in the browser. */
  readonly manual: boolean;
  /** An update downloads as soon as a check finds it; off, each waits for the user to start it. */
  readonly autoDownload: boolean;
}

/** What asking to restart into the update did: `working` when agents would stop and it wasn't forced. */
export type InstallResult = "started" | "working" | "unavailable";

declare global {
  interface Window {
    readonly cerium?: ShellBridge;
  }
}

/** Whether the desktop app runs on Windows, whose own names its settings use. */
export const onWindows = (): boolean => window.cerium?.platform === "win32";

/**
 * Whether the desktop app runs on macOS, whose own names (the menu bar, login) its settings use; the
 * browser preview stands in for it with `?platform=darwin` (main.tsx).
 */
export const onMac = (): boolean => document.documentElement.dataset["platform"] === "darwin";

/**
 * The shell's bridge. While the window drives another machine, what reaches this computer's
 * files is left out: a path from that machine means nothing here, so files are shown and picked on
 * that machine itself, and attachments travel as bytes.
 */
export const shellBridge = (): ShellBridge | undefined => {
  const bridge = window.cerium;
  if (bridge === undefined || drivenMachine() === undefined) return bridge;
  const {
    pickFolder: _pick,
    pathForFile: _path,
    revealPath: _reveal,
    openPath: _open,
    ...elsewhere
  } = bridge;
  return elsewhere;
};

/**
 * Asks the user for a folder: the native dialog in Electron, a prompt in the browser preview. None
 * while the window drives another machine, whose folders this computer can't show.
 */
export const pickFolder = async (): Promise<string | undefined> => {
  if (drivenMachine() !== undefined) return undefined;
  const bridge = shellBridge();
  if (bridge?.pickFolder) return bridge.pickFolder();
  const path = window.prompt("Folder for this thread (full path)")?.trim();
  return path === "" ? undefined : path;
};
