// The theme the visitor picked on the home page, which every page wears after. It's a convenience
// kept in this browser only; a page renders in Cerium's own theme whenever storage is unavailable.

/** The app's themes, in its order (apps/ui/src/features/settings/palettes.ts); their colours are the app's own CSS. */
export const palettes: ReadonlyArray<string> = [
  "cerium",
  "ink",
  "paper",
  "concrete",
  "cherry",
  "phosphor",
  "lagoon",
  "flamingo",
  "midnight",
  "neon",
];

const key = "cerium-site:palette";

export const savedPalette = (): string => {
  try {
    const saved = localStorage.getItem(key);
    return saved !== null && palettes.includes(saved) ? saved : "cerium";
  } catch {
    return "cerium";
  }
};

export const setPalette = (id: string) => {
  document.documentElement.dataset.palette = id;
  try {
    localStorage.setItem(key, id);
  } catch {
    // Storage is blocked; the choice lasts for this page.
  }
};
