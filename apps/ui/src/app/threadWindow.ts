import { useContext, useEffect } from "react";
import { RegistryContext } from "@effect/atom-react";

import { shellBridge } from "../backend/shell.ts";
import { WEB } from "../backend/target.ts";
import {
  scaleAtom,
  sendKeyAtom,
  textSizeAtom,
  themeAtom,
  windowSolidAtom,
} from "../features/settings/preferences.ts";
import {
  focusPane,
  leavesOf,
  paneShowing,
  showInPane,
  splitPane,
  type Panes,
} from "../features/split/model.ts";
import type { AppMode } from "./mode.ts";

// A thread in a window of its own, beside the main one (apps/desktop/src/threadWindows.ts): the same
// page, which its address tells to show that one thread with its side panels and its terminal, and
// nothing of the rest of the window. It talks to the same backend, so the thread's events, approvals
// and drafts are the same in both; the main window keeps the account's syncs, the agents' browser and
// the notifications.

export interface SoloThread {
  readonly id: string;
  readonly mode: AppMode;
}

/** The thread this window shows alone, when it's a thread's own window; development takes the same address. */
export const soloThread: SoloThread | undefined = (() => {
  if (WEB || (shellBridge() === undefined && !import.meta.env.DEV)) return undefined;
  const params = new URLSearchParams(location.search);
  // `?window=<thread id>&mode=work`; `thread` is a tapped notification's (web/push.ts).
  const id = params.get("window");
  const mode = params.get("mode");
  return id && (mode === "work" || mode === "chat") ? { id, mode } : undefined;
})();

/**
 * Opens one of this computer's threads in a window of its own, or brings its window forward; none
 * where there are no such windows: the web client, the browser preview, and a thread's window itself.
 */
export const threadWindowOpener = () => (soloThread ? undefined : shellBridge()?.openThreadWindow);

/**
 * `panes` with the tab `key` beside the thread `threadId` in its own window, which has no tabs to put
 * it in: in the pane already showing it, else in place of whatever shows beside the thread, else in a
 * new pane `id` to the thread's right. The tab's pane takes focus.
 */
export const besideThread = (panes: Panes, threadId: string, key: string, id: string): Panes => {
  const showing = paneShowing(panes.root, key);
  if (showing !== undefined) return focusPane(panes, showing.id);
  const other = leavesOf(panes.root).find((leaf) => leaf.key !== threadId);
  if (other !== undefined) return focusPane(showInPane(panes, other.id, key), other.id);
  const thread = paneShowing(panes.root, threadId) ?? leavesOf(panes.root)[0];
  return thread === undefined ? panes : splitPane(panes, thread.id, "right", key, id);
};

/**
 * Keeps this window's look in step with Cerium's other windows: a theme, text size, scale or send key
 * picked in one reaches the others through their shared storage.
 */
export function useSharedPreferences() {
  const registry = useContext(RegistryContext);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      // Drafts follow on their own (composer/drafts.ts), a keystroke at a time.
      if (event.key === null || !event.key.startsWith("cerium:") || event.key.startsWith("cerium:draft"))
        return;
      registry.refresh(themeAtom);
      registry.refresh(textSizeAtom);
      registry.refresh(scaleAtom);
      registry.refresh(windowSolidAtom);
      registry.refresh(sendKeyAtom);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [registry]);
}
