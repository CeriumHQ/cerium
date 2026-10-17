import { useLayoutEffect } from "react";

import { shellBridge } from "../../backend/shell.ts";
import type { Theme } from "./preferences.ts";

const darkScheme = () => window.matchMedia("(prefers-color-scheme: dark)");

const showTheme = (theme: Theme) => {
  document.documentElement.dataset["theme"] =
    theme === "system" ? (darkScheme().matches ? "dark" : "light") : theme;
};

/**
 * Keeps the page on the chosen theme, following Windows while it's "system", and asks the shell to
 * draw the window's glass and caption buttons to match. Applied before paint, so the window never
 * flashes the other theme.
 */
export const useTheme = (theme: Theme) => {
  useLayoutEffect(() => {
    showTheme(theme);
    shellBridge()?.setTheme?.(theme);
    if (theme !== "system") return;
    const query = darkScheme();
    const follow = () => showTheme("system");
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [theme]);
};
