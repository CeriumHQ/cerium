import { readFileSync, writeFileSync } from "node:fs";

import type { BrowserWindow, Rectangle } from "electron";

// A thread in a window of its own, beside the main one: the same page, told by its address to show
// that one thread. Each thread has at most one; asking again brings it forward. Closing one leaves
// the thread running, as closing a tab does. The windows open when Cerium quits come back where they
// were on its next start, so a thread kept on a second monitor stays there; one closed by hand
// doesn't.

export type ThreadMode = "work" | "chat";

/** A thread window as it's remembered across starts. */
export interface SavedThreadWindow {
  readonly threadId: string;
  readonly mode: ThreadMode;
  /** Where it was, unmaximized; none to let the system place it. */
  readonly bounds?: Rectangle;
  readonly maximized?: boolean;
}

/** A thread's id as the backend gives it: what a window's address may carry. */
export const isThreadId = (value: unknown): value is string =>
  typeof value === "string" && /^[\w-]{1,100}$/.test(value);

export const isThreadMode = (value: unknown): value is ThreadMode => value === "work" || value === "chat";

const isRectangle = (value: unknown): value is Rectangle => {
  if (typeof value !== "object" || value === null) return false;
  const rect = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((key) => Number.isFinite(rect[key]));
};

/** The windows a file remembers; whatever doesn't read as one is left out. */
export const parseSavedWindows = (text: string | undefined): ReadonlyArray<SavedThreadWindow> => {
  if (text === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry: unknown): Array<SavedThreadWindow> => {
    if (typeof entry !== "object" || entry === null) return [];
    const { threadId, mode, bounds, maximized } = entry as Record<string, unknown>;
    if (!isThreadId(threadId) || !isThreadMode(mode)) return [];
    return [
      {
        threadId,
        mode,
        ...(isRectangle(bounds) ? { bounds } : {}),
        ...(maximized === true ? { maximized } : {}),
      },
    ];
  });
};

/** How much of a window must still be on some screen to open where it was: enough to grab it by. */
const GRAB = 80;

/** Whether `bounds` still shows on one of the screens' work areas, which may have changed since. */
export const onScreen = (bounds: Rectangle, areas: ReadonlyArray<Rectangle>) =>
  areas.some(
    (area) =>
      Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x) >= GRAB &&
      Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y) >= GRAB / 2,
  );

/** How long after the last move or resize the windows' places are written down. */
const SAVE_DELAY_MS = 500;

export const threadWindows = (options: {
  /** Where the open windows are remembered. */
  readonly file: string;
  /**
   * Builds and loads a thread's window, at `bounds` when given; one `restored` at start opens behind
   * the main window rather than taking the focus from it.
   */
  readonly create: (thread: {
    threadId: string;
    mode: ThreadMode;
    bounds?: Rectangle;
    restored: boolean;
  }) => BrowserWindow;
  /** The screens' work areas now. */
  readonly screens: () => ReadonlyArray<Rectangle>;
}) => {
  const open = new Map<string, { readonly mode: ThreadMode; readonly window: BrowserWindow }>();
  /** Cerium is quitting: the windows closing now come back next time. */
  let quitting = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    const windows = [...open].flatMap(([threadId, { mode, window }]): Array<SavedThreadWindow> =>
      window.isDestroyed()
        ? []
        : [
            {
              threadId,
              mode,
              bounds: window.getNormalBounds(),
              ...(window.isMaximized() ? { maximized: true } : {}),
            },
          ],
    );
    try {
      writeFileSync(options.file, JSON.stringify(windows));
    } catch {
      // Not remembered this time; the windows themselves are unaffected.
    }
  };
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DELAY_MS);
  };

  const show = (saved: SavedThreadWindow, restored: boolean) => {
    const existing = open.get(saved.threadId)?.window;
    if (existing !== undefined && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return;
    }
    const bounds = saved.bounds && onScreen(saved.bounds, options.screens()) ? saved.bounds : undefined;
    const window = options.create({
      threadId: saved.threadId,
      mode: saved.mode,
      ...(bounds ? { bounds } : {}),
      restored,
    });
    if (saved.maximized === true && bounds !== undefined) window.maximize();
    open.set(saved.threadId, { mode: saved.mode, window });
    window.on("resize", saveSoon);
    window.on("move", saveSoon);
    window.on("maximize", saveSoon);
    window.on("unmaximize", saveSoon);
    window.on("closed", () => {
      if (quitting) return;
      if (open.get(saved.threadId)?.window === window) open.delete(saved.threadId);
      save();
    });
    save();
  };

  return {
    /** Opens `threadId` in a window of its own, or brings forward the one it has. */
    open: (threadId: string, mode: ThreadMode) => show({ threadId, mode }, false),
    /** Reopens the windows open when Cerium last quit, where they were. */
    restore: () => {
      let text: string | undefined;
      try {
        text = readFileSync(options.file, "utf8");
      } catch {
        text = undefined;
      }
      for (const saved of parseSavedWindows(text)) show(saved, true);
    },
    /** The window showing `threadId`, if it has one. */
    windowOf: (threadId: string) => {
      const window = open.get(threadId)?.window;
      return window === undefined || window.isDestroyed() ? undefined : window;
    },
    /** Cerium is quitting: remembers the windows open now, which close with it and come back next start. */
    quit: () => {
      if (quitting) return;
      save();
      quitting = true;
    },
  };
};
