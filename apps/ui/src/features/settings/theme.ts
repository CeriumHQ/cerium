import { useAtomValue } from "@effect/atom-react";
import { useLayoutEffect, useSyncExternalStore } from "react";

import { shellBridge } from "../../backend/shell.ts";
import { desktopProperties, useDesktopColors } from "./desktopColors.ts";
import { paletteAtom } from "./palettes.ts";
import type { Theme } from "./preferences.ts";

const darkScheme = () => window.matchMedia("(prefers-color-scheme: dark)");

const show = (dark: boolean) => {
  document.documentElement.dataset["theme"] = dark ? "dark" : "light";
};

let settle: () => void = () => undefined;
/**
 * Resolves once the page shows the theme it starts in: at once in a browser, and in the desktop
 * shell once the system has said what "system" means (and on Windows tinted the glass to match).
 */
export const themeSettled = new Promise<void>((resolve) => {
  settle = resolve;
});

/**
 * Keeps the page on the chosen theme, following the operating system while it's "system", and in the
 * chosen palette, with the desktop's colours at hand for the Desktop one. Applied before paint, so the window never flashes the other theme. In the desktop
 * shell, the system also draws the caption buttons to match (on Windows, tints the glass too), and
 * says what "system" currently means.
 */
export const useTheme = (theme: Theme) => {
  const palette = useAtomValue(paletteAtom);
  useLayoutEffect(() => {
    document.documentElement.dataset["palette"] = palette;
  }, [palette]);

  // The Desktop theme's colours, which `data-desktop` announces to whatever reads the tokens once.
  const desktop = useDesktopColors();
  useLayoutEffect(() => {
    if (desktop === undefined) return;
    const root = document.documentElement;
    const properties = desktopProperties(desktop);
    for (const [name, value] of Object.entries(properties)) root.style.setProperty(name, value);
    root.dataset["desktop"] = Object.values(properties).join(" ");
  }, [desktop]);

  useLayoutEffect(() => {
    const follows = theme === "system";
    // The page's own guess for "system" holds until the shell answers.
    show(follows ? darkScheme().matches : theme === "dark");

    const bridge = shellBridge();
    if (bridge?.setTheme) {
      let current = true;
      void bridge.setTheme(theme).then((dark) => {
        if (current && follows) show(dark);
        settle();
      }, settle);
      const stop = bridge.onDarkColorsChange?.((dark) => {
        if (follows) show(dark);
      });
      return () => {
        current = false;
        stop?.();
      };
    }
    settle();

    if (!follows) return;
    const query = darkScheme();
    const follow = () => show(query.matches);
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [theme]);
};

const subscribeShown = (onChange: () => void) => {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
};
const shown = (): "dark" | "light" =>
  document.documentElement.dataset["theme"] === "light" ? "light" : "dark";

/** The mode on screen now: the chosen one, or what "system" currently means. */
export const useShownTheme = () => useSyncExternalStore(subscribeShown, shown);
