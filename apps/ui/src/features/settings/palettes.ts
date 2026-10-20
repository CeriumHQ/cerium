import { Atom } from "effect/reactivity";

import { remember, stored } from "../../lib/storage.ts";

/**
 * The themes Cerium ships. Settings calls these themes, and the light or dark choice (`themeAtom`,
 * `data-theme`) the mode; the page calls them palettes (`data-palette`). Each works in either mode;
 * their colours are in styles/themes.css.
 */
export const palettes = [
  { id: "cerium", label: "Cerium" },
  { id: "amber", label: "Amber" },
  { id: "uranium", label: "Uranium" },
  { id: "seaglass", label: "Sea glass" },
  { id: "cobalt", label: "Cobalt" },
  { id: "cranberry", label: "Cranberry" },
] as const;
export type Palette = (typeof palettes)[number]["id"];

const PALETTE_KEY = "cerium:palette";

/** This window's palette, kept in its local storage like its other preferences; Cerium until changed. */
export const paletteAtom = Atom.writable(
  (): Palette => palettes.find((palette) => palette.id === stored(PALETTE_KEY))?.id ?? "cerium",
  (context, value: Palette) => {
    context.setSelf(value);
    remember(PALETTE_KEY, value);
  },
).pipe(Atom.keepAlive);
