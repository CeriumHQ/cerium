import { useEffect, useState } from "react";

import { rememberForTab, storedForTab } from "../../lib/storage.ts";
import { previewBridge } from "./model.ts";

/**
 * The threads whose preview shows, kept as long as their pages: a reload finds them as they were, and
 * a new launch, with no pages yet, starts with none.
 */
const OPEN_KEY = "cerium:previewsOpen";

const readOpen = (): ReadonlyArray<string> => {
  try {
    const parsed: unknown = JSON.parse(storedForTab(OPEN_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
};

export interface PreviewDocks {
  /** Whether `threadId`'s preview shows beside its conversation. */
  readonly isOpen: (threadId: string) => boolean;
  readonly show: (threadId: string) => void;
  /** Hides the thread's preview; its page stays as it was, for the thread's agents and for showing again. */
  readonly hide: (threadId: string) => void;
  /** Hides the thread's preview, and its page closes with it: an agent's next call opens a fresh one. */
  readonly close: (threadId: string) => void;
  readonly retire: (threadId: string) => void;
}

/** Which threads show their preview, each its own: opening one thread's leaves the others' as they were. */
export function usePreviewDocks(): PreviewDocks {
  const [open, setOpen] = useState(readOpen);
  useEffect(() => rememberForTab(OPEN_KEY, JSON.stringify(open)), [open]);
  useEffect(
    () => previewBridge()?.onClosed((threadId) => setOpen((ids) => ids.filter((id) => id !== threadId))),
    [],
  );
  const hide = (threadId: string) => setOpen((ids) => ids.filter((id) => id !== threadId));
  return {
    isOpen: (threadId) => open.includes(threadId),
    show: (threadId) => setOpen((ids) => (ids.includes(threadId) ? ids : [...ids, threadId])),
    hide,
    close: (threadId) => {
      previewBridge()?.close(threadId);
      hide(threadId);
    },
    retire: (threadId) => {
      previewBridge()?.retire?.(threadId);
      hide(threadId);
    },
  };
}
