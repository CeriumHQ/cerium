// The glass the visitor picked on the home page, which every page wears after. It's a convenience
// kept in this browser only; a page renders in Cerium's clear glass whenever storage is unavailable.

/** Each theme's light, in the app's dark-mode accent: what tints the prism and the bench. */
export const palettes: Readonly<Record<string, string>> = {
  cerium: "#ffffff",
  amber: "oklch(0.8 0.13 70)",
  uranium: "oklch(0.89 0.19 123)",
  seaglass: "oklch(0.86 0.09 180)",
  cobalt: "oklch(0.66 0.19 264)",
  cranberry: "oklch(0.77 0.13 356)",
};

const key = "cerium-site:palette";

export const savedPalette = (): string => {
  try {
    const saved = localStorage.getItem(key);
    return saved !== null && saved in palettes ? saved : "cerium";
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
