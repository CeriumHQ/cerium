import type { TerminalId } from "@cerium/rpc";
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";

import { remember, stored } from "../../lib/storage.ts";
import { ownerKey, type TerminalOwner } from "./model.ts";
import { TerminalDrawer } from "./TerminalDrawer.tsx";

const OPEN_KEY = "cerium:terminalsOpen";
/** How many threads' (and projects') open drawers are remembered. */
const REMEMBERED = 50;

const readOpen = (): ReadonlyArray<string> => {
  try {
    const parsed: unknown = JSON.parse(stored(OPEN_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
};

export interface TerminalDrawerControl {
  /** What's open can have a terminal. */
  readonly available: boolean;
  readonly open: boolean;
  /** Shows or hides the drawer, as its titlebar button does. */
  readonly toggle: () => void;
  readonly hide: () => void;
  /** The drawer, to place under the thread's conversation; none while it is hidden. */
  readonly drawer: ReactNode;
}

/**
 * The terminal drawer of what's open: whether it shows (remembered per thread or project, across
 * launches), which terminal each last showed, and Ctrl ` to show it, move the cursor into it and hide
 * it. `owner` is the open work thread, or the project of the new work thread being written; none for
 * a chat or anything this machine can't run terminals for. A suspended window (settings) leaves the
 * shortcut alone.
 */
export function useTerminalDrawer({
  owner,
  suspended,
  compact,
}: {
  owner: TerminalOwner | undefined;
  suspended: boolean;
  compact: boolean;
}): TerminalDrawerControl {
  const [openIds, setOpenIds] = useState(readOpen);
  const [chosen, setChosen] = useState<Readonly<Record<string, string>>>({});
  const [focus, setFocus] = useState(0);
  const key = owner === undefined ? undefined : ownerKey(owner);
  const available = key !== undefined;
  const open = key !== undefined && openIds.includes(key);

  const setOpen = (id: string, next: boolean) => {
    const ids = next
      ? [id, ...openIds.filter((each) => each !== id)].slice(0, REMEMBERED)
      : openIds.filter((each) => each !== id);
    setOpenIds(ids);
    remember(OPEN_KEY, JSON.stringify(ids));
  };

  const show = () => {
    if (key === undefined) return;
    setOpen(key, true);
    setFocus((count) => count + 1);
  };
  const hide = () => {
    if (key !== undefined) setOpen(key, false);
  };

  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!event.ctrlKey || event.code !== "Backquote" || event.altKey || event.metaKey || event.shiftKey)
      return;
    if (suspended || key === undefined) return;
    event.preventDefault();
    if (!open) show();
    else if (document.activeElement?.closest("[data-terminal-drawer]") == null)
      setFocus((count) => count + 1);
    else hide();
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onShortcut(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  return {
    available,
    open,
    toggle: () => (open ? hide() : show()),
    hide,
    drawer:
      open && owner !== undefined && key !== undefined ? (
        <TerminalDrawer
          key={key}
          owner={owner}
          chosen={chosen[key]}
          onChoose={(id: TerminalId) => setChosen((current) => ({ ...current, [key]: id }))}
          focus={compact ? 0 : focus}
          compact={compact}
          onHide={hide}
          onNewFocus={() => setFocus((count) => count + 1)}
        />
      ) : null,
  };
}
