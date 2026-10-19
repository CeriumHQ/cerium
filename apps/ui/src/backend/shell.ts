import { drivenMachine } from "./machine.ts";

/** Where the UI reaches the backend. */
export interface BackendConnection {
  readonly url: string;
  readonly token: string;
}

/**
 * A right-click no page menu claimed, as the app-wide text menu needs it. The shell keeps the rest
 * (the selected text, the word, the link) and acts on it when the page names a command.
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
  /** The misspelled word right-clicked, with up to three replacements. */
  readonly misspelling?: { readonly word: string; readonly suggestions: ReadonlyArray<string> };
  /** A link was right-clicked; only `https` links open. */
  readonly link?: { readonly openable: boolean };
}

/** What the text menu asks the shell to do with the right-click it last reported. */
export type TextCommand =
  | {
      readonly kind:
        | "cut"
        | "copy"
        | "paste"
        | "selectAll"
        | "copySelection"
        | "addToDictionary"
        | "openLink"
        | "copyLink";
    }
  | { readonly kind: "replaceMisspelling"; readonly suggestion: number };

/** What Electron's preload exposes as `window.cerium`; absent in the browser preview. */
export interface ShellBridge {
  readonly shell: "electron";
  readonly platform: string;
  /**
   * Where the shell's own backend listens, once it does; asked on every connect, since a restarted
   * backend has a new port and token. Undefined in development, where the UI asks the dev server.
   */
  readonly backendConnection?: () => Promise<BackendConnection | undefined>;
  readonly pickFolder?: () => Promise<string | undefined>;
  /** Where a pasted or dropped file lives on disk; undefined for one that only exists in memory. */
  readonly pathForFile?: (file: File) => string | undefined;
  /** Shows a file or folder (absolute path) in the system's file manager. */
  readonly revealPath?: (path: string) => Promise<void>;
  /**
   * Saves an image where the user picks with the native Save dialog, suggesting `name`. `source` is
   * a `data:image/…;base64,` URL or an absolute path to an image file. Resolves whether it was saved.
   */
  readonly saveImage?: (source: string, name: string) => Promise<boolean>;
  /**
   * Windows tints the window's Acrylic and draws its caption buttons in this theme. Resolves whether
   * that means dark colours, which for "system" is Windows' own choice.
   */
  readonly setTheme?: (theme: "system" | "dark" | "light") => Promise<boolean>;
  /** Calls back whenever Windows' colours turn dark or light; returns how to stop. */
  readonly onDarkColorsChange?: (listener: (dark: boolean) => void) => () => void;
  /** Calls back on every right-click no page menu claimed; returns how to stop. */
  readonly onTextMenu?: (listener: (request: TextMenuRequest) => void) => () => void;
  /** Runs a text menu command on the last right-click, in the focused field or frame. */
  readonly runTextCommand?: (command: TextCommand) => Promise<void>;
  /**
   * Whether this machine is signed in to a Cerium account and whether agents are working: signed in,
   * closing the window hides it to the tray, and working too, the PC is kept awake.
   */
  readonly setPresence?: (presence: { signedIn: boolean; working: boolean }) => void;
  /** Whether Cerium starts when the user signs in to Windows; only the installed app can. */
  readonly startAtLogin?: () => Promise<StartAtLogin>;
  readonly setStartAtLogin?: (enabled: boolean) => Promise<StartAtLogin>;
  /** The update channel the user follows and what it offers (apps/desktop/src/updater.ts). */
  readonly updates?: () => Promise<Updates>;
  readonly checkForUpdates?: () => Promise<Updates>;
  /** Follows another channel and checks it at once. */
  readonly setUpdateChannel?: (channel: UpdateChannel) => Promise<Updates>;
  /** Downloads the update a check found; progress arrives through `onUpdatesChange`. */
  readonly downloadUpdate?: () => Promise<void>;
  /** Quits, installs the downloaded update and starts it. */
  readonly installUpdate?: () => Promise<void>;
  /** Calls back whenever what the updater knows changes; returns how to stop. */
  readonly onUpdatesChange?: (listener: (updates: Updates) => void) => () => void;
}

export interface StartAtLogin {
  readonly available: boolean;
  readonly enabled: boolean;
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
  /** The releases couldn't be read: `offline`, or `unpublished` when the channel has none to read. */
  | { readonly kind: "unreachable"; readonly reason: "offline" | "unpublished"; readonly checkedAt: number }
  | { readonly kind: "failed"; readonly version: string };

export interface Updates {
  readonly channel: UpdateChannel;
  /** The running build's version and channel. */
  readonly version: string;
  readonly buildChannel: UpdateChannel;
  readonly status: UpdateStatus;
}

declare global {
  interface Window {
    readonly cerium?: ShellBridge;
  }
}

/**
 * The shell's bridge. While the window drives another machine, what reaches this computer's
 * files is left out: a path from that machine means nothing here, so files are shown and picked on
 * that machine itself, and attachments travel as bytes.
 */
export const shellBridge = (): ShellBridge | undefined => {
  const bridge = window.cerium;
  if (bridge === undefined || drivenMachine() === undefined) return bridge;
  const { pickFolder: _pick, pathForFile: _path, revealPath: _reveal, ...elsewhere } = bridge;
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
