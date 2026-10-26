import { useAtomValue } from "@effect/atom-react";
import { useLayoutEffect } from "react";

import { scaleAtom, windowSolidAtom } from "./preferences.ts";

/** Whether the system puts glass behind this window: Acrylic on Windows, Vibrancy on macOS. */
export const hasGlass = () => "acrylic" in document.documentElement.dataset;

/** Keeps the window as solid as chosen, by the share of the theme's glass it holds back. */
export const useWindowSolid = () => {
  const solid = useAtomValue(windowSolidAtom);
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--window-solid", String(solid / 100));
  }, [solid]);
};

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
