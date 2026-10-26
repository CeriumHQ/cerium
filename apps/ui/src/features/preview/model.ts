import { isLocalUrl } from "@cerium/browser/url";

import type { PreviewBridge, PreviewState } from "../../backend/shell.ts";

// The Preview pane: a thread's browser, which the user watches and the thread's agents drive. The
// desktop shell keeps each thread's page; this is what the window knows of them: the tab that shows
// one, what each page shows now, and who opens a local address a terminal printed or linked.

// ---------------------------------------------------------------------------------------------
// Tabs

const PREVIEW_PREFIX = "preview:";

/** The tab key of a thread's preview. */
export const previewKey = (threadId: string) => `${PREVIEW_PREFIX}${threadId}`;

/** The thread whose preview a tab key names; undefined for any other key. */
export const previewOfKey = (key: string | undefined): string | undefined => {
  if (key?.startsWith(PREVIEW_PREFIX) !== true) return undefined;
  const threadId = key.slice(PREVIEW_PREFIX.length);
  return threadId === "" ? undefined : threadId;
};

/** What the address bar shows of `url` while it isn't being edited: the host and path, without `http://`. */
export const shortUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
    return `${parsed.host}${rest}`;
  } catch {
    return url;
  }
};

/** What a preview's tab and pane are called: the page's title, else its address, else "Preview". */
export const previewTitle = (state: PreviewState | undefined): string =>
  state?.title.trim() || (state?.url ? shortUrl(state.url) : "") || "Preview";

// ---------------------------------------------------------------------------------------------
// What each page shows, as the shell reports it

const isState = (value: unknown): value is PreviewState =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as PreviewState).threadId === "string" &&
  typeof (value as PreviewState).url === "string";

let states: Readonly<Record<string, PreviewState>> = {};
const listeners = new Set<() => void>();
let stopWatching: (() => void) | undefined;

const publish = (next: Readonly<Record<string, PreviewState>>) => {
  states = next;
  for (const listener of listeners) listener();
};

/** The shell's bridge to the pages, in the desktop app. */
export const previewBridge = (): PreviewBridge | undefined => window.cerium?.preview;

/** Calls back as any page's state changes; for `useSyncExternalStore`. */
export const subscribePreviews = (listener: () => void): (() => void) => {
  listeners.add(listener);
  const bridge = previewBridge();
  if (stopWatching === undefined && bridge !== undefined) {
    const offState = bridge.onState((state) => {
      if (isState(state)) publish({ ...states, [state.threadId]: state });
    });
    const offClosed = bridge.onClosed((threadId) => {
      const { [threadId]: _closed, ...rest } = states;
      publish(rest);
    });
    void bridge.states().then((all) => {
      if (!Array.isArray(all)) return;
      publish({
        ...Object.fromEntries(all.filter(isState).map((state) => [state.threadId, state])),
        ...states,
      });
    });
    stopWatching = () => {
      offState();
      offClosed();
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopWatching?.();
      stopWatching = undefined;
    }
  };
};

/** Every open page's state, by thread. */
export const previewStates = (): Readonly<Record<string, PreviewState>> => states;

// ---------------------------------------------------------------------------------------------
// Local addresses from terminals

let localOpener: ((url: string) => void) | undefined;

/** Who opens a local address a terminal linked or printed: the window, while it can show a preview. */
export const setLocalOpener = (opener: ((url: string) => void) | undefined) => {
  localOpener = opener;
};

/** Whether the preview can open local addresses now. */
export const canOpenLocally = (): boolean => localOpener !== undefined;

/** Opens `url` in the preview when it's a local address and the window can; answers whether it did. */
export const openLocally = (url: string): boolean => {
  if (localOpener === undefined || !isLocalUrl(url)) return false;
  localOpener(url);
  return true;
};
