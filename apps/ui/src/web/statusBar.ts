// Installed on an iPhone's Home Screen, the page starts below an opaque status bar, which iOS paints in
// the page's theme colour. That colour follows the theme and palette chosen in Cerium, so the bar reads
// as the top of the window: its glass over the backdrop, as one solid colour.

/** The window's glass over its backdrop, which is what the top bar under the status bar shows. */
const WINDOW = "color-mix(in srgb, var(--window) calc(var(--window-alpha) * 100%), var(--backdrop))";

/** `colour` as `#rrggbb`, the form every browser takes for a theme colour. */
const hex = (context: CanvasRenderingContext2D, colour: string) => {
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = colour;
  context.fillRect(0, 0, 1, 1);
  const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
};

/** Keeps the page's theme colour the window's own, through changes to the mode and the palette. */
export const followThemeColor = () => {
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (context === null) return;
  // Reads the tokens the page is styled with now, which a canvas can't resolve itself.
  const probe = document.createElement("div");
  probe.hidden = true;
  probe.style.backgroundColor = WINDOW;
  document.body.append(probe);

  const update = () => {
    const colour = hex(context, getComputedStyle(probe).backgroundColor);
    const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
    if (metas.length === 0) {
      const meta = document.createElement("meta");
      meta.name = "theme-color";
      meta.content = colour;
      document.head.append(meta);
    }
    // Both of the page's light and dark ones, since the mode is Cerium's choice, not the phone's.
    for (const meta of metas) meta.content = colour;
  };
  new MutationObserver(update).observe(document.documentElement, {
    attributeFilter: ["data-theme", "data-palette"],
  });
  update();
};
