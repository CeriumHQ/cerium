import { useLayoutEffect } from "react";

import { shellBridge } from "../../backend/shell.ts";
import type { Theme } from "./preferences.ts";

const darkScheme = () => window.matchMedia("(prefers-color-scheme: dark)");

const show = (dark: boolean) => {
  document.documentElement.dataset["theme"] = dark ? "dark" : "light";
};

/**
 * Keeps the page on the chosen theme, following the operating system while it's "system". Applied
 * before paint, so the window never flashes the other theme. In the desktop shell, Windows also tints
 * the glass and draws the caption buttons to match, and says what "system" currently means.
 */
export const useTheme = (theme: Theme) => {
  useLayoutEffect(() => {
    const follows = theme === "system";
    // The page's own guess for "system" holds until the shell answers.
    show(follows ? darkScheme().matches : theme === "dark");

    const bridge = shellBridge();
    if (bridge?.setTheme) {
      let current = true;
      void bridge.setTheme(theme).then((dark) => {
        if (current && follows) show(dark);
      });
      const stop = bridge.onDarkColorsChange?.((dark) => {
        if (follows) show(dark);
      });
      return () => {
        current = false;
        stop?.();
      };
    }

    if (!follows) return;
    const query = darkScheme();
    const follow = () => show(query.matches);
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [theme]);
};
