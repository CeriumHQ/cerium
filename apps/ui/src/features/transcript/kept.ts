import { createContext, use, useLayoutEffect, useRef, useState } from "react";

/**
 * What a conversation remembers about items that unmount as they scroll out of view and mount
 * again as they come back: which the reader opened or closed, and how tall each artifact drew.
 * One per open thread.
 */
export class KeptState {
  readonly open = new Map<string, boolean>();
  /** By the artifact's code: a frame drawn again starts at its height instead of a placeholder's. */
  readonly heights = new Map<string, number>();
  /**
   * How tall each of the latest items drew, on screen, by its id. One that moves into the history
   * as the conversation goes on starts there at its height: starting at a guess, the conversation
   * would shrink for a moment, and the end of it would lose the view.
   */
  readonly sizes = new Map<string, number>();
}

export const Kept = createContext<KeptState | undefined>(undefined);

/**
 * Whether the item `key` names was opened or closed by the reader, kept for the conversation:
 * undefined until they choose. Outside a conversation it lasts as long as the component.
 */
export function useKeptOpen(key: string): readonly [boolean | undefined, (open: boolean) => void] {
  const kept = use(Kept);
  const [open, setOpen] = useState(() => kept?.open.get(key));
  const choose = (next: boolean) => {
    kept?.open.set(key, next);
    setOpen(next);
  };
  return [open, choose];
}

/** Keeps the height on screen of the element it's attached to, by `key`, as it draws and changes. */
export function useKeptSize<E extends HTMLElement>(key: string) {
  const kept = use(Kept);
  const element = useRef<E>(null);
  useLayoutEffect(() => {
    const target = element.current;
    if (kept === undefined || target === null) return;
    const keep = () => kept.sizes.set(key, target.getBoundingClientRect().height);
    keep();
    const observer = new ResizeObserver(keep);
    observer.observe(target);
    return () => observer.disconnect();
  }, [kept, key]);
  return element;
}

/** An artifact's last drawn height in this conversation, and a way to keep a new one. */
export function useKeptHeight(code: string): readonly [number | undefined, (height: number) => void] {
  const kept = use(Kept);
  const [height, setHeight] = useState(() => kept?.heights.get(code));
  const keep = (next: number) => {
    kept?.heights.set(code, next);
    setHeight(next);
  };
  return [height, keep];
}
