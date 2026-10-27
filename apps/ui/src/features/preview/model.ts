import { isLocalUrl } from "@cerium/browser/url";

import type { PreviewBridge, PreviewState } from "../../backend/shell.ts";

// The Preview: a thread's browser, docked in its pane beside the conversation, which the user watches
// and the thread's agents drive. The desktop shell keeps each thread's page; this is what the window
// knows of them: how the dock shares its pane, what each page shows now, and who opens a local
// address a terminal printed or linked.

// ---------------------------------------------------------------------------------------------
// The dock

/**
 * The dock's share of its thread's pane until the user drags it, the least it takes, and what it
 * always leaves the conversation beside it.
 */
export const DOCK = { key: "cerium:previewShare", share: 0.5, min: 320, beside: 400 } as const;

export interface DockLayout {
  /** The pane is too narrow for both: the page covers the conversation until it closes. */
  readonly covers: boolean;
  readonly width: number;
  readonly min: number;
  readonly max: number;
}

/** How a pane `paneWidth` wide divides between the conversation and its page, at `share` of it. */
export const dockLayout = (paneWidth: number, share: number): DockLayout => {
  const max = Math.floor(paneWidth - DOCK.beside);
  if (max < DOCK.min) return { covers: true, width: paneWidth, min: paneWidth, max: paneWidth };
  const width = Math.min(Math.max(Math.round(share * paneWidth), DOCK.min), max);
  return { covers: false, width, min: DOCK.min, max };
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
