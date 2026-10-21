// The themes switcher: a theme and a mode pick one of twelve captures of the same thread. The picture
// waits in the window's back layer until it has loaded, then the two layers cross, so a clear glass and
// an opaque one never show at once, while the light behind the window turns to the theme's hues.

const shots = import.meta.glob<string>("./media/themes/*.webp", { eager: true, import: "default" });

interface Theme {
  readonly name: string;
  readonly line: string;
  /** The light behind the window, as the hues at its ends and middle. */
  readonly light: readonly [string, string, string];
}

const themes: Record<string, Theme> = {
  cerium: {
    name: "Cerium",
    line: "Clear glass, with your desktop showing through.",
    light: ["var(--ray-claude)", "var(--ray-cursor)", "var(--ray-opencode)"],
  },
  amber: {
    name: "Amber",
    line: "Brown bottle glass, with honey in the light.",
    light: ["oklch(0.62 0.16 45)", "oklch(0.8 0.14 75)", "oklch(0.58 0.13 40)"],
  },
  uranium: {
    name: "Uranium",
    line: "Vaseline glass: olive by day, chartreuse under a lamp.",
    light: ["oklch(0.62 0.13 115)", "oklch(0.9 0.2 123)", "oklch(0.6 0.12 130)"],
  },
  seaglass: {
    name: "Sea glass",
    line: "Pale aqua, frosted by the tide.",
    light: ["oklch(0.72 0.1 200)", "oklch(0.86 0.09 175)", "oklch(0.7 0.09 35)"],
  },
  cobalt: {
    name: "Cobalt",
    line: "Deep blue bottle glass.",
    light: ["oklch(0.5 0.22 268)", "oklch(0.62 0.2 258)", "oklch(0.45 0.2 280)"],
  },
  cranberry: {
    name: "Cranberry",
    line: "Gold-ruby glass, rose in the light.",
    light: ["oklch(0.55 0.18 10)", "oklch(0.75 0.14 356)", "oklch(0.5 0.15 330)"],
  },
};

const source = (palette: string, mode: string) => shots[`./media/themes/${palette}-${mode}.webp`] ?? "";

const preload = (url: string) => {
  const image = new Image();
  image.src = url;
};

export const startThemes = (section: HTMLElement) => {
  const layers = [...section.querySelectorAll<HTMLImageElement>("[data-theme-shot]")];
  const line = section.querySelector<HTMLElement>("[data-line]");
  const glow = section.querySelector<HTMLElement>("[data-glow]");
  const beads = [...section.querySelectorAll<HTMLButtonElement>("[data-palette]")];
  const modes = [...section.querySelectorAll<HTMLButtonElement>("[data-mode]")];
  const [first, second] = layers;
  if (first === undefined || second === undefined || line === null || glow === null) return;

  let palette = "cerium";
  let mode = "dark";
  let front = first;
  let back = second;
  let wanted = 0;

  const show = async () => {
    const theme = themes[palette]!;
    const request = ++wanted;
    for (const bead of beads) bead.setAttribute("aria-pressed", String(bead.dataset["palette"] === palette));
    for (const button of modes) button.setAttribute("aria-pressed", String(button.dataset["mode"] === mode));
    line.textContent = theme.line;
    glow.style.setProperty("--from", theme.light[0]);
    glow.style.setProperty("--via", theme.light[1]);
    glow.style.setProperty("--to", theme.light[2]);
    section.dataset["palette"] = palette;
    section.dataset["mode"] = mode;

    back.src = source(palette, mode);
    try {
      await back.decode();
    } catch {
      return;
    }
    // A later pick has taken over while this one loaded.
    if (request !== wanted) return;
    back.alt = `Cerium in the ${theme.name} theme, ${mode}: a finished thread's table of who did what, with the agents panel beside it`;
    back.removeAttribute("aria-hidden");
    back.toggleAttribute("data-on", true);
    front.alt = "";
    front.setAttribute("aria-hidden", "true");
    front.removeAttribute("data-on");
    [front, back] = [back, front];
  };

  for (const bead of beads) {
    const pick = bead.dataset["palette"] ?? "cerium";
    bead.addEventListener("click", () => {
      palette = pick;
      void show();
    });
    // Fetched as the pointer comes near, so the change is quick.
    bead.addEventListener("pointerenter", () => preload(source(pick, mode)));
  }
  for (const button of modes) {
    const pick = button.dataset["mode"] ?? "dark";
    button.addEventListener("click", () => {
      mode = pick;
      void show();
    });
    button.addEventListener("pointerenter", () => preload(source(palette, pick)));
  }
};
