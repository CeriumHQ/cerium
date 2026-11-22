import { Atom } from "effect/reactivity";

import { shellBridge } from "../../backend/shell.ts";
import { remember, stored } from "../../lib/storage.ts";

/**
 * The themes Cerium ships. Settings calls these themes, and the light or dark choice (`themeAtom`,
 * `data-theme`) the mode; the page calls them palettes (`data-palette`). Each works in either mode;
 * Cerium's colours are the base in styles/tokens.css and the rest are in styles/themes.css. Cerium
 * first, then the neutrals, then the tinted ones round the wheel, red to violet.
 *
 * `kind` is a few words on what sets a theme apart, and `description` a sentence of it, as Settings
 * and the welcome tell them.
 */
export const palettes = [
  {
    id: "cerium",
    label: "Cerium",
    kind: "Charcoal and ceria",
    description:
      "Warm charcoal glass and a champagne accent, the pale yellow of the oxide glass is polished with.",
  },
  {
    id: "ink",
    label: "Ink",
    kind: "Pure monochrome",
    description: "No tint at all: the deepest dark, the whitest light, and a red pencil in the code.",
  },
  {
    id: "paper",
    label: "Paper",
    kind: "Cream and ink",
    description:
      "Cream stock and espresso, written on in blue-black ink. The most solid glass, and muted code.",
  },
  {
    id: "dusk",
    label: "Dusk",
    kind: "Soft and lifted",
    description: "The sky after sunset: softer, lighter blue-grey glass, a peach accent and pastel code.",
  },
  {
    id: "concrete",
    label: "Concrete",
    kind: "Grey and safety yellow",
    description: "Cool grey and charcoal with no colour of their own, and one saturated safety yellow.",
  },
  {
    id: "blush",
    label: "Blush",
    kind: "Rose quartz",
    description: "Lifted mulberry glass and a powder-rose accent, with pastel code.",
  },
  {
    id: "ember",
    label: "Ember",
    kind: "Smoke and flame",
    description: "Smoky brown-black glass and a flame-orange accent, its code warm against one cool blue.",
  },
  {
    id: "cherry",
    label: "Cherry",
    kind: "Butter and cherry red",
    description: "Butter and olive-brown, soft as an old diner, and one cherry red.",
  },
  {
    id: "moss",
    label: "Moss",
    kind: "Forest floor",
    description: "Deep green glass and a fern accent, with straw and rust in the code.",
  },
  {
    id: "phosphor",
    label: "Phosphor",
    kind: "Green screen",
    description: "Near-black glass and text that glows green, like a terminal's tube.",
  },
  {
    id: "lagoon",
    label: "Lagoon",
    kind: "Teal and coral",
    description: "Shallow water over sand: teal glass, a coral accent and sand in the code.",
  },
  {
    id: "flamingo",
    label: "Flamingo",
    kind: "Mist and flamingo pink",
    description: "Mist and deep teal, cool and still, and one flamingo pink.",
  },
  {
    id: "midnight",
    label: "Midnight",
    kind: "Navy and cyan",
    description: "Deep, saturated navy glass with an electric cyan accent, gold and coral in the code.",
  },
  {
    id: "neon",
    label: "Neon",
    kind: "Full chroma",
    description: "A sign in the rain: violet glass, a hot-pink accent, and code at full colour.",
  },
] as const;
export type Glass = (typeof palettes)[number]["id"];

/**
 * The theme the user's own desktop draws, from its wallpaper and accent colour (desktopColors.ts).
 * Only the desktop shell can read those, so only it offers this one.
 */
export const desktopPalette = {
  id: "desktop",
  label: "Desktop",
  kind: "Your own",
  description: "Tinted by your wallpaper, in your system's accent colour.",
} as const;
export type Palette = Glass | typeof desktopPalette.id;

/** A theme's entry: its name and how it's described. */
export const paletteEntry = (palette: Palette) =>
  palette === desktopPalette.id ? desktopPalette : palettes.find((each) => each.id === palette);

export const paletteLabel = (palette: Palette) => paletteEntry(palette)?.label;

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
