import { Atom } from "effect/reactivity";

import { shellBridge } from "../../backend/shell.ts";
import { remember, stored } from "../../lib/storage.ts";

/**
 * The themes Cerium ships. Settings calls these themes, and the light or dark choice (`themeAtom`,
 * `data-theme`) the mode; the page calls them palettes (`data-palette`). Each works in either mode;
 * their colours are in styles/themes.css. The clear one first, then the tinted ones round the
 * spectrum, red to violet.
 */
export const palettes = [
  { id: "cerium", label: "Cerium" },
  { id: "cranberry", label: "Cranberry" },
  { id: "amber", label: "Amber" },
  { id: "uranium", label: "Uranium" },
  { id: "forest", label: "Forest" },
  { id: "seaglass", label: "Sea glass" },
  { id: "cobalt", label: "Cobalt" },
  { id: "amethyst", label: "Amethyst" },
] as const;
export type Glass = (typeof palettes)[number]["id"];

/**
 * The theme the user's own desktop draws, from its wallpaper and accent colour (desktopColors.ts).
 * Only the desktop shell can read those, so only it offers this one.
 */
export const desktopPalette = { id: "desktop", label: "Desktop" } as const;
export type Palette = Glass | typeof desktopPalette.id;

export const paletteLabel = (palette: Palette) =>
  palette === desktopPalette.id ? desktopPalette.label : palettes.find((each) => each.id === palette)?.label;

const PALETTE_KEY = "cerium:palette";

/** This window's palette, kept in its local storage like its other preferences; Cerium until changed. */
export const paletteAtom = Atom.writable(
  (): Palette => {
    const saved = stored(PALETTE_KEY);
    if (saved === desktopPalette.id && shellBridge()?.desktopColors !== undefined) return desktopPalette.id;
    return palettes.find((palette) => palette.id === saved)?.id ?? "cerium";
  },
  (context, value: Palette) => {
    context.setSelf(value);
    remember(PALETTE_KEY, value);
  },
).pipe(Atom.keepAlive);
