import { useAtomValue } from "@effect/atom-react";
import { useLayoutEffect } from "react";

import { scaleAtom } from "./preferences.ts";

/** Whether this window can be scaled: the desktop shell zooms it; a browser has its own zoom. */
export const canScale = () => window.cerium?.setZoom !== undefined;

/**
 * Keeps the desktop window at the chosen scale. Applied before paint, so the shell has it before the
 * launch screen shows the window.
 */
export const useScale = () => {
  const scale = useAtomValue(scaleAtom);
  useLayoutEffect(() => {
    window.cerium?.setZoom?.(scale / 100);
  }, [scale]);
};

/**
 * What a key pressed with Ctrl does to the scale: + and − step it, on the main keys or the numpad,
 * and the numpad's 0 puts it back to 100% (the main row's Ctrl 0 opens a thread).
 */
export const scaleShortcut = (event: {
  readonly key: string;
  readonly code: string;
}): -1 | 1 | "reset" | undefined => {
  if (event.key === "=" || event.key === "+" || event.code === "NumpadAdd") return 1;
  if (event.key === "-" || event.key === "_" || event.code === "NumpadSubtract") return -1;
  if (event.code === "Numpad0") return "reset";
  return undefined;
};
