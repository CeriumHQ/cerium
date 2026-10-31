import {
  CdpError,
  isPreviewable,
  Page,
  previewUrl,
  runCommand,
  type BrowserCommand,
  type BrowserReport,
  type CdpSession,
  type Listener,
} from "@cerium/browser";
import {
  BaseWindow,
  ipcMain,
  session,
  WebContentsView,
  type BrowserWindow,
  type Rectangle,
  type WebContents,
  type NavigationEntry,
} from "electron";

import { releasablePreviews } from "./previewRetention.ts";

// The Preview pane's browser: one page per thread, in a view of its own over the window, which the
// user watches and the thread's agents drive. The UI says where its pane is (or that it's away), and
// the shell lays the view there. A page the user can't see moves, while agents drive it, to a window
// of its own far off screen, which never takes focus and stays off the taskbar: a view outside its
// window's bounds draws nothing, and the agents' screenshots need it drawn. Once they stop it goes
// back to Cerium's window, hidden. Pages live
// in a session of their own: they share no storage with Cerium's window, get no preload, may open
// http and https only, and are granted no permission. The agents' calls reach the shell through the
// UI (`HostBrowser` in @cerium/rpc), which hands them to `run` here.

/** The pages' own session: none of Cerium's storage, kept across launches like a browser's. */
const PARTITION = "persist:cerium-preview";

/** How long a page agents drove stays drawing off screen after their last call. */
const PARKED_MS = 30_000;

/** Where the parking window sits: beyond any display's edge. */
const PARKING_AT = { x: -32_000, y: -32_000 };

/** The size a page takes before its pane ever showed it. */
const FIRST_SIZE = { width: 1280, height: 800 };

/** What the pane's toolbar shows of its page. */
export interface PreviewState {
  readonly threadId: string;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /** Why the last load failed, if it did. */
  readonly error?: string;
}

interface Preview {
  readonly threadId: string;
  readonly view: WebContentsView;
  /** Where the pane shows it, in window pixels, or none while it's away. */
  shown: Rectangle | undefined;
  /** The window the view is in now: Cerium's, or the parking window off screen. */
  parent: BaseWindow;
  size: { width: number; height: number };
  parkedUntil: number;
  page: Promise<Page> | undefined;
  error: string | undefined;
  calls: number;
  lastUsed: number;
  restoring: Promise<void> | undefined;
}

/** CDP over the view's own debugger: no port is opened, and no other program reaches the page. */
const debuggerSession = (contents: WebContents): CdpSession => {
  const listeners = new Map<string, Set<Listener>>();
  const onMessage = (_event: Electron.Event, method: string, params: any) => {
    for (const listener of listeners.get(method) ?? []) listener(params);
  };
  // A session ends with its attachment: the next attachment's session takes the debugger's messages
  // alone, rather than every page the view was ever driven as hearing them too.
  const release = () => {
    contents.debugger.removeListener("message", onMessage);
    contents.debugger.removeListener("detach", release);
    listeners.clear();
  };
  contents.debugger.on("message", onMessage);
  contents.debugger.on("detach", release);
  const on = (method: string, listener: Listener) => {
    const set = listeners.get(method) ?? new Set();
    set.add(listener);
    listeners.set(method, set);
    return () => void set.delete(listener);
  };
  return {
    get closed() {
      return contents.isDestroyed() || !contents.debugger.isAttached();
    },
    send: (method, params = {}, timeoutMs = 30_000) =>
      new Promise((resolve, reject) => {
        if (contents.isDestroyed() || !contents.debugger.isAttached()) {
          reject(new CdpError("The page is closed."));
          return;
        }
        const timer = setTimeout(
          () => reject(new CdpError(`${method} took longer than ${timeoutMs / 1000} s.`)),
          timeoutMs,
        );
        contents.debugger.sendCommand(method, params).then(
          (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(new CdpError(error instanceof Error ? error.message : String(error)));
          },
        );
      }),
    on,
    once: (method, timeoutMs) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          off();
          resolve(undefined);
        }, timeoutMs);
        const off = on(method, (params) => {
          clearTimeout(timer);
          off();
          resolve(params);
        });
      }),
    close: () => {
      if (contents.isDestroyed()) return;
      release();
      if (contents.debugger.isAttached()) contents.debugger.detach();
    },
  };
};

const isRect = (value: unknown): value is Rectangle =>
  typeof value === "object" &&
  value !== null &&
  ["x", "y", "width", "height"].every((key) => typeof (value as Record<string, unknown>)[key] === "number");

/** The page's address; empty while nothing is open, the blank page the debugger needs included. */
const urlOf = (contents: WebContents): string => {
  const url = contents.getURL();
  return url === "about:blank" ? "" : url;
};

const isThread = (value: unknown): value is string =>
  typeof value === "string" && /^[\w-]{1,200}$/.test(value);

/** Lays out the threads' pages over `window()` and answers the UI's and agents' calls on them. */
export const previews = (window: () => BrowserWindow | undefined) => {
  const all = new Map<string, Preview>();
  const saved = new Map<string, { entries: Array<NavigationEntry>; index: number }>();
  let activeThreads = new Set<string>();
  let retiredThreads = new Set<string>();
  let archivedThreads = new Set<string>();
  let knownThreads = new Set<string>();
  let lifecycleKnown = false;
  let cleanupTimer: NodeJS.Timeout | undefined;
  let configured = false;

  const previewSession = () => {
    const pages = session.fromPartition(PARTITION);
    if (!configured) {
      configured = true;
      // Pages ask for nothing: no camera, location, notifications or anything else.
      pages.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      pages.setPermissionCheckHandler(() => false);
      // Nothing a page offers lands on the user's disk.
      pages.on("will-download", (event) => event.preventDefault());
      pages.setSpellCheckerEnabled(false);
    }
    return pages;
  };

  const stateOf = (preview: Preview): PreviewState => {
    const contents = preview.view.webContents;
    const url = urlOf(contents);
    return {
      threadId: preview.threadId,
      url,
      title: url === "" ? "" : contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      ...(preview.error === undefined ? {} : { error: preview.error }),
    };
  };

  const report = (preview: Preview) => {
    if (all.get(preview.threadId) !== preview) return;
    const owner = window();
    if (owner === undefined || owner.isDestroyed() || preview.view.webContents.isDestroyed()) return;
    owner.webContents.send("cerium:preview-state", stateOf(preview));
  };

  let parking: BaseWindow | undefined;

  /** The window off screen where pages agents drive out of the user's sight keep drawing. */
  const parkingWindow = (): BaseWindow => {
    if (parking === undefined || parking.isDestroyed()) {
      parking = new BaseWindow({
        ...PARKING_AT,
        ...FIRST_SIZE,
        show: false,
        frame: false,
        focusable: false,
        skipTaskbar: true,
        resizable: false,
        title: "Cerium preview",
      });
    }
    return parking;
  };

  /** Moves the view into `parent`, if it isn't there already. */
  const moveTo = (preview: Preview, parent: BaseWindow) => {
    if (preview.parent === parent) return;
    if (!preview.parent.isDestroyed()) preview.parent.contentView.removeChildView(preview.view);
    parent.contentView.addChildView(preview.view);
    preview.parent = parent;
  };

  /** Puts the view where it belongs now: in its pane, in the parking window for agents, or hidden. */
  const place = (preview: Preview) => {
    const owner = window();
    if (owner === undefined || owner.isDestroyed()) return;
    const { view } = preview;
    view.webContents.setBackgroundThrottling(
      preview.calls === 0 && !activeThreads.has(preview.threadId) && Date.now() >= preview.parkedUntil,
    );
    if (preview.shown !== undefined) {
      moveTo(preview, owner);
      view.setBounds(preview.shown);
      view.setVisible(true);
    } else if (Date.now() < preview.parkedUntil) {
      // At the size the pane gave it, so the agents see the page as the user would.
      const parked = parkingWindow();
      moveTo(preview, parked);
      const { width, height } = parked.getContentBounds();
      if (width < preview.size.width || height < preview.size.height) {
        parked.setContentBounds({
          ...PARKING_AT,
          width: Math.max(width, preview.size.width),
          height: Math.max(height, preview.size.height),
        });
      }
      view.setBounds({ x: 0, y: 0, ...preview.size });
      view.setVisible(true);
      if (!parked.isVisible()) parked.showInactive();
    } else {
      view.setVisible(false);
      moveTo(preview, owner);
    }
    releaseParking();
  };

  /** Closes the parking window once no page is in it. */
  const releaseParking = () => {
    if (parking === undefined || [...all.values()].some((each) => each.parent === parking)) return;
    if (!parking.isDestroyed()) parking.destroy();
    parking = undefined;
  };

  const create = (threadId: string): Preview => {
    const owner = window();
    if (owner === undefined || owner.isDestroyed()) throw new CdpError("Cerium's window isn't open.");
    const view = new WebContentsView({
      webPreferences: {
        session: previewSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: true,
      },
    });
    view.setBackgroundColor("#ffffff");
    view.setBorderRadius(8);
    view.setVisible(false);
    owner.contentView.addChildView(view);
    const preview: Preview = {
      threadId,
      view,
      shown: undefined,
      parent: owner,
      size: FIRST_SIZE,
      parkedUntil: 0,
      page: undefined,
      error: undefined,
      calls: 0,
      lastUsed: Date.now(),
      restoring: undefined,
    };
    const contents = view.webContents;
    // http and https only, wherever a page tries to go; a popup opens in the same view.
    contents.setWindowOpenHandler(({ url }) => {
      if (isPreviewable(url)) void contents.loadURL(url).catch(() => undefined);
      return { action: "deny" };
    });
    const guard = (event: { preventDefault: () => void }, url: string) => {
      if (!isPreviewable(url)) event.preventDefault();
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    contents.on("will-frame-navigate", (event) => {
      if (event.isMainFrame && !isPreviewable(event.url)) event.preventDefault();
    });
    const changed = () => report(preview);
    contents.on("did-start-loading", () => {
      preview.error = undefined;
      changed();
    });
    contents.on("did-stop-loading", changed);
    contents.on("did-navigate", changed);
    contents.on("did-navigate-in-page", changed);
    contents.on("page-title-updated", changed);
    contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      // -3 is a load the next one replaced.
      if (!isMainFrame || code === -3) return;
      preview.error = `${description || "The page didn't load"} (${url})`;
      changed();
    });
    // A crashed page's view shows nothing: it's dropped, and the next call opens a fresh one.
    contents.on("render-process-gone", () => {
      if (all.get(threadId) === preview) close(threadId);
    });
    all.set(threadId, preview);
    const history = saved.get(threadId);
    if (history !== undefined) {
      saved.delete(threadId);
      preview.restoring = contents.navigationHistory
        .restore({ entries: history.entries, index: history.index })
        .catch(() => undefined);
    }
    scheduleCleanup();
    return preview;
  };

  const open = (threadId: string) => all.get(threadId) ?? create(threadId);

  const close = (threadId: string, remember = false) => {
    if (!remember) saved.delete(threadId);
    const preview = all.get(threadId);
    if (preview === undefined) return;
    all.delete(threadId);
    retiredThreads.delete(threadId);
    if (remember && !preview.view.webContents.isDestroyed()) {
      const history = preview.view.webContents.navigationHistory;
      const active = history.getActiveIndex();
      const from = Math.max(0, active - 10);
      const entries = history
        .getAllEntries()
        .slice(from, from + 20)
        .map(({ url, title }) => ({ url, title }));
      if (entries.length > 0) saved.set(threadId, { entries, index: active - from });
      if (saved.size > 100) saved.delete(saved.keys().next().value!);
    }
    if (!preview.view.webContents.isDestroyed()) preview.view.webContents.close();
    if (!preview.parent.isDestroyed()) preview.parent.contentView.removeChildView(preview.view);
    releaseParking();
    const owner = window();
    if (owner === undefined || owner.isDestroyed()) return;
    owner.webContents.send("cerium:preview-closed", threadId);
  };

  const cleanup = () => {
    if (!lifecycleKnown) return;
    const pages = [...all.values()].map((preview) => ({
      threadId: preview.threadId,
      shown: preview.shown !== undefined,
      active: activeThreads.has(preview.threadId),
      calls: preview.calls,
      lastUsed: preview.lastUsed,
      parkedUntil: preview.parkedUntil,
      retired: retiredThreads.has(preview.threadId),
    }));
    for (const threadId of releasablePreviews(pages, Date.now())) close(threadId, true);
  };

  const scheduleCleanup = () => {
    if (cleanupTimer !== undefined || all.size === 0) return;
    cleanupTimer = setTimeout(() => {
      cleanupTimer = undefined;
      cleanup();
      scheduleCleanup();
    }, 30_000);
    cleanupTimer.unref();
  };

  /**
   * The page to drive, attached the first time and again if something detached it. A view that has
   * loaded nothing has no renderer to answer the debugger yet, so it gets a blank page first.
   */
  const pageOf = (preview: Preview): Promise<Page> => {
    const contents = preview.view.webContents;
    if (preview.page === undefined || !contents.debugger.isAttached()) {
      const attached = (async () => {
        await preview.restoring;
        if (contents.getURL() === "") await contents.loadURL("about:blank");
        if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
        const session = debuggerSession(contents);
        try {
          const page = await Page.attach(session);
          // The page takes the agents' clicks and keys as if it had focus: the window's own page
          // holds it, and Chromium drops input to a view without it, whether or not the user sees it.
          await page.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
          return page;
        } catch (error) {
          // The next call attaches afresh, with a session of its own.
          session.close();
          throw error;
        }
      })();
      preview.page = attached;
      // A failed attach is tried again on the next call.
      attached.catch(() => {
        if (preview.page === attached) preview.page = undefined;
      });
    }
    return preview.page;
  };

  /** Loads `url`, resolving once it has (or failed to). */
  const load = async (preview: Preview, url: string) => {
    preview.error = undefined;
    try {
      await preview.view.webContents.loadURL(url);
    } catch (error) {
      const code = (error as { errno?: number }).errno;
      if (code === -3) return;
      throw new CdpError(`Couldn't open ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** Runs an agent's call on `threadId`'s page, opening it first if it isn't. */
  const run = async (threadId: string, command: BrowserCommand): Promise<BrowserReport> => {
    const preview = open(threadId);
    preview.calls++;
    preview.lastUsed = Date.now();
    preview.parkedUntil = Date.now() + PARKED_MS;
    place(preview);
    try {
      const page = await pageOf(preview);
      if (urlOf(preview.view.webContents) === "" && command._tag !== "Open") {
        throw new CdpError("Nothing is open in the browser yet: browser_open a page first.");
      }
      return await runCommand(page, command, (url) => load(preview, url));
    } finally {
      preview.calls--;
      preview.lastUsed = Date.now();
      preview.parkedUntil = Date.now() + PARKED_MS;
      if (
        all.get(threadId) === preview &&
        retiredThreads.has(threadId) &&
        preview.calls === 0 &&
        !activeThreads.has(threadId)
      )
        close(threadId, true);
      else cleanup();
      setTimeout(() => {
        if (all.get(threadId) === preview) place(preview);
      }, PARKED_MS + 100);
    }
  };

  ipcMain.handle("cerium:preview-run", async (_event, threadId: unknown, command: unknown) => {
    if (!isThread(threadId) || typeof command !== "object" || command === null) {
      return { _tag: "Failed", message: "That isn't a call the browser takes." };
    }
    try {
      return { _tag: "Done", ...(await run(threadId, command as BrowserCommand)) };
    } catch (error) {
      return { _tag: "Failed", message: error instanceof Error ? error.message : String(error) };
    }
  });

  /** Where the pane shows `threadId`'s page, in the window's CSS pixels, or `null` while it's away. */
  ipcMain.on("cerium:preview-place", (event, threadId: unknown, bounds: unknown) => {
    if (!isThread(threadId) || (bounds !== null && !isRect(bounds))) return;
    const owner = window();
    if (owner === undefined || event.sender !== owner.webContents) return;
    const preview = bounds === null ? all.get(threadId) : open(threadId);
    if (preview === undefined) return;
    preview.lastUsed = Date.now();
    if (bounds === null) preview.shown = undefined;
    else {
      const zoom = owner.webContents.getZoomFactor();
      const shown = {
        x: Math.round(bounds.x * zoom),
        y: Math.round(bounds.y * zoom),
        width: Math.max(1, Math.round(bounds.width * zoom)),
        height: Math.max(1, Math.round(bounds.height * zoom)),
      };
      preview.shown = shown;
      preview.size = { width: shown.width, height: shown.height };
    }
    place(preview);
  });

  /** The user typed an address, or pressed back, forward, reload or stop. */
  ipcMain.handle("cerium:preview-navigate", async (_event, threadId: unknown, input: unknown) => {
    if (!isThread(threadId) || typeof input !== "string") return false;
    const url = previewUrl(input);
    if (url === undefined) return false;
    void load(open(threadId), url).catch(() => undefined);
    return true;
  });
  ipcMain.on("cerium:preview-go", (_event, threadId: unknown, go: unknown) => {
    const preview = isThread(threadId) ? all.get(threadId) : undefined;
    if (preview === undefined) return;
    const contents = preview.view.webContents;
    if (go === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    if (go === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    if (go === "reload") contents.reload();
    if (go === "stop") contents.stop();
  });
  ipcMain.on("cerium:preview-close", (_event, threadId: unknown) => {
    if (isThread(threadId)) close(threadId);
  });

  ipcMain.on("cerium:preview-retire", (event, threadId: unknown) => {
    const owner = window();
    if (
      owner === undefined ||
      event.sender !== owner.webContents ||
      !isThread(threadId) ||
      !all.has(threadId)
    )
      return;
    // A successful archive already stopped the agents; the shell still owns any outstanding call.
    activeThreads.delete(threadId);
    retiredThreads.add(threadId);
    if (all.get(threadId)!.calls === 0) close(threadId, true);
  });

  // Only the main window hosts the local backend's browser; remote and other windows own none.
  ipcMain.on("cerium:preview-threads", (event, threads: unknown) => {
    const owner = window();
    if (owner === undefined || event.sender !== owner.webContents || !Array.isArray(threads)) return;
    if (
      !threads.every(
        (thread: unknown) =>
          typeof thread === "object" &&
          thread !== null &&
          isThread((thread as { id?: unknown }).id) &&
          typeof (thread as { active?: unknown }).active === "boolean" &&
          typeof (thread as { retired?: unknown }).retired === "boolean",
      )
    )
      return;
    const known = threads as Array<{ id: string; active: boolean; retired: boolean }>;
    activeThreads = new Set(known.filter((thread) => thread.active).map((thread) => thread.id));
    const archived = new Set(known.filter((thread) => thread.retired).map((thread) => thread.id));
    for (const thread of known) {
      if (thread.retired && !archivedThreads.has(thread.id) && all.has(thread.id))
        retiredThreads.add(thread.id);
      if (!thread.retired) retiredThreads.delete(thread.id);
    }
    archivedThreads = archived;
    const ids = new Set(known.map((thread) => thread.id));
    for (const id of knownThreads) if (!ids.has(id) && all.has(id)) retiredThreads.add(id);
    knownThreads = ids;
    lifecycleKnown = true;
    cleanup();
    for (const preview of all.values()) place(preview);
  });

  /** What the page shows now, as a PNG data URL, for the pane to draw while something covers it. */
  ipcMain.handle("cerium:preview-still", async (_event, threadId: unknown) => {
    const preview = isThread(threadId) ? all.get(threadId) : undefined;
    if (preview === undefined || urlOf(preview.view.webContents) === "") return undefined;
    const image = await preview.view.webContents.capturePage(undefined, { stayHidden: true });
    return image.isEmpty() ? undefined : image.toDataURL();
  });

  /** Every page open now, for a UI that loaded after them. */
  ipcMain.handle("cerium:preview-states", () => [...all.values()].map(stateOf));

  return {
    /** Whether `contents` is one of the previews' pages, which the app window's own rules leave alone. */
    owns: (contents: WebContents) => contents.session === session.fromPartition(PARTITION),
    /** The window's page reloads: its panes are gone until it lays them out again; the pages stay. */
    unplaceAll: () => {
      for (const preview of all.values()) {
        preview.shown = undefined;
        place(preview);
      }
    },
    /** The window closed: the pages go with it. */
    closeAll: () => {
      if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
      cleanupTimer = undefined;
      for (const threadId of [...all.keys()]) close(threadId);
      saved.clear();
    },
  };
};
