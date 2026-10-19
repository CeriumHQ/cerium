import type { ITheme } from "@xterm/xterm";

// The terminal's colours, read from the design tokens (the chrome's own, and the palette in
// styles/terminal.css) each time the theme changes. The emulator wants plain colours, and the tokens
// are written in OKLCH, so a canvas turns each into the form it takes.

let probe: CanvasRenderingContext2D | null | undefined;

/** A CSS colour as `#rrggbb` or `rgba(…)`, the forms the emulator reads. */
const plain = (css: string): string => {
  probe ??= document.createElement("canvas").getContext("2d");
  if (probe === null) return css;
  probe.fillStyle = "#000000";
  probe.fillStyle = css;
  return probe.fillStyle;
};

/** The sixteen ANSI colours: the emulator's name for each, and its token's. */
const ANSI = {
  black: "black",
  red: "red",
  green: "green",
  yellow: "yellow",
  blue: "blue",
  magenta: "magenta",
  cyan: "cyan",
  white: "white",
  brightBlack: "bright-black",
  brightRed: "bright-red",
  brightGreen: "bright-green",
  brightYellow: "bright-yellow",
  brightBlue: "bright-blue",
  brightMagenta: "bright-magenta",
  brightCyan: "bright-cyan",
  brightWhite: "bright-white",
} as const;

/** The emulator's theme as the page's tokens say it now. The background stays clear: the drawer's own surface shows. */
export const readTheme = (element: Element = document.documentElement): ITheme => {
  const style = getComputedStyle(element);
  const token = (name: string) => plain(style.getPropertyValue(name).trim());
  const colours = Object.fromEntries(
    Object.entries(ANSI).map(([key, name]) => [key, token(`--terminal-${name}`)]),
  ) as Record<keyof typeof ANSI, string>;
  return {
    background: "rgba(0, 0, 0, 0)",
    foreground: token("--fg-primary"),
    cursor: token("--fg-primary"),
    cursorAccent: token("--accent-fg"),
    selectionBackground: token("--selection"),
    selectionInactiveBackground: token("--surface-active"),
    scrollbarSliderBackground: token("--surface-active"),
    scrollbarSliderHoverBackground: token("--line-strong"),
    scrollbarSliderActiveBackground: token("--line-strong"),
    ...colours,
  };
};
