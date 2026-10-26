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
