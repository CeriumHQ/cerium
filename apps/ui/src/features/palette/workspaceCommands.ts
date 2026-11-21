import { Monitor, Moon, Palette as PaletteIcon, SquarePen, Sun } from "lucide-react";

import { projectName } from "../composer/projectList.ts";
import { desktopPalette, palettes, type Palette } from "../settings/palettes.ts";
import type { Theme } from "../settings/preferences.ts";
import type { PaletteCommand } from "./palette.ts";

/**
 * A new thread in each project, its full path as the row's detail so two folders with one name tell
 * apart, and searched by it too.
 */
export const projectCommands = (
  paths: ReadonlyArray<string>,
): ReadonlyArray<Omit<PaletteCommand, "run"> & { readonly folder: string }> =>
  paths.map((path) => ({
    id: `new-thread:${path}`,
    group: "Projects",
    label: `New thread in ${projectName(path)}`,
    detail: path,
    keywords: path,
    icon: SquarePen,
    folder: path,
  }));

/**
 * The appearance (light, dark, or the system's) and the theme, apart: one flips the mode shown now,
 * the other recolours it, each under the icon of what it picks.
 */
export function appearanceCommands({
  shown,
  desktop,
  setTheme,
  setPalette,
}: {
  readonly shown: "light" | "dark";
  readonly desktop: boolean;
  readonly setTheme: (theme: Theme) => void;
  readonly setPalette: (palette: Palette) => void;
}): ReadonlyArray<PaletteCommand> {
  const next = shown === "dark" ? "light" : "dark";
  const available = desktop ? [...palettes, desktopPalette] : palettes;
  return [
    {
      id: "toggle-appearance",
      group: "Actions",
      label: `Switch to ${next} appearance`,
      icon: next === "dark" ? Moon : Sun,
      keywords: "toggle light dark mode appearance",
      run: () => setTheme(next),
    },
    {
      id: "system-appearance",
      group: "Settings",
      label: "Use system appearance",
      icon: Monitor,
      keywords: "light dark mode auto os",
      run: () => setTheme("system"),
    },
    ...available.map(({ id, label }): PaletteCommand => ({
      id: `theme:${id}`,
      group: "Settings",
      label: `Switch theme to ${label}`,
      icon: PaletteIcon,
      keywords: "theme palette colour color",
      run: () => setPalette(id),
    })),
  ];
}
