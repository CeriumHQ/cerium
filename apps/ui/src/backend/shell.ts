/** Where the UI reaches the backend. */
export interface BackendConnection {
  readonly url: string;
  readonly token: string;
}

/** What Electron's preload exposes as `window.cerium`; absent in the browser preview. */
export interface ShellBridge {
  readonly shell: "electron";
  readonly platform: string;
  /** The packaged app's backend; in development the UI asks the dev server instead. */
  readonly backend?: BackendConnection;
  readonly pickFolder?: () => Promise<string | undefined>;
  /**
   * Windows tints the window's Acrylic and draws its caption buttons in this theme. Resolves whether
   * that means dark colours, which for "system" is Windows' own choice.
   */
  readonly setTheme?: (theme: "system" | "dark" | "light") => Promise<boolean>;
  /** Calls back whenever Windows' colours turn dark or light; returns how to stop. */
  readonly onDarkColorsChange?: (listener: (dark: boolean) => void) => () => void;
}

declare global {
  interface Window {
    readonly cerium?: ShellBridge;
  }
}

export const shellBridge = (): ShellBridge | undefined => window.cerium;

/** Asks the user for a folder: the native dialog in Electron, a prompt in the browser preview. */
export const pickFolder = async (): Promise<string | undefined> => {
  const bridge = shellBridge();
  if (bridge?.pickFolder) return bridge.pickFolder();
  const path = window.prompt("Folder for this thread (full path)")?.trim();
  return path === "" ? undefined : path;
};
