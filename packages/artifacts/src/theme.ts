// The theme an artifact draws with: Cerium's design tokens under the names agents already know from
// shadcn/ui, so a page written for any app reads well in this one. The window sends its current values,
// and again whenever the user changes theme or mode, so a page follows without reloading.

export type ArtifactMode = "dark" | "light";

export interface ArtifactTheme {
  readonly mode: ArtifactMode;
  /** Each variable in `THEME_TOKENS` with its CSS value. */
  readonly variables: Readonly<Record<string, string>>;
}

/** Each variable a page sees, and the Cerium token (apps/ui/src/styles/tokens.css) it takes its value from. */
export const THEME_TOKENS = {
  "--background": "--window",
  "--foreground": "--fg-primary",
  "--muted-foreground": "--fg-secondary",
  "--subtle-foreground": "--fg-tertiary",
  "--card": "--surface-raised",
  "--card-foreground": "--fg-primary",
  "--popover": "--surface-overlay",
  "--popover-foreground": "--fg-primary",
  "--muted": "--surface-hover",
  "--secondary": "--surface-active",
  "--secondary-foreground": "--fg-primary",
  "--accent": "--surface-selected",
  "--accent-foreground": "--fg-primary",
  "--primary": "--accent",
  "--primary-foreground": "--accent-fg",
  "--primary-soft": "--accent-soft",
  "--border": "--line-subtle",
  "--border-strong": "--line-strong",
  "--input": "--line-strong",
  "--ring": "--focus-ring",
  "--selection": "--selection",
  "--info": "--status-running",
  "--success": "--status-success",
  "--warning": "--status-attention",
  "--destructive": "--status-error",
  "--chart-1": "--series-1",
  "--chart-2": "--series-2",
  "--chart-3": "--series-3",
  "--chart-4": "--series-4",
  "--chart-5": "--series-5",
  "--chart-6": "--series-6",
  "--chart-7": "--series-7",
  "--chart-8": "--series-8",
  "--shadow": "--shadow-raised",
  "--shadow-lg": "--shadow-overlay",
} as const satisfies Record<string, string>;

/** A theme read from the window's tokens: `read` gives a Cerium token's computed value. */
export const themeFromTokens = (mode: ArtifactMode, read: (token: string) => string): ArtifactTheme => ({
  mode,
  variables: Object.fromEntries(
    Object.entries(THEME_TOKENS).map(([name, token]) => [name, read(token).trim()]),
  ),
});

const series = {
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
};

/**
 * The default Cerium theme's values, for a page drawn where no window can say (the preview tool), and
 * for the moment before the window's arrive. Keep them in step with tokens.css.
 */
export const DEFAULT_THEMES: Readonly<Record<ArtifactMode, ArtifactTheme>> = {
  dark: {
    mode: "dark",
    variables: {
      "--background": "oklch(0.17 0 0)",
      "--foreground": "oklch(0.96 0 0)",
      "--muted-foreground": "oklch(0.78 0 0)",
      "--subtle-foreground": "oklch(0.6 0 0)",
      "--card": "oklch(0.255 0 0 / 0.78)",
      "--card-foreground": "oklch(0.96 0 0)",
      "--popover": "oklch(0.22 0 0 / 0.94)",
      "--popover-foreground": "oklch(0.96 0 0)",
      "--muted": "oklch(1 0 0 / 0.05)",
      "--secondary": "oklch(1 0 0 / 0.085)",
      "--secondary-foreground": "oklch(0.96 0 0)",
      "--accent": "oklch(1 0 0 / 0.09)",
      "--accent-foreground": "oklch(0.96 0 0)",
      "--primary": "oklch(0.95 0 0)",
      "--primary-foreground": "oklch(0.17 0 0)",
      "--primary-soft": "color-mix(in oklab, oklch(0.95 0 0) 11%, transparent)",
      "--border": "oklch(1 0 0 / 0.07)",
      "--border-strong": "oklch(1 0 0 / 0.14)",
      "--input": "oklch(1 0 0 / 0.14)",
      "--ring": "color-mix(in oklab, oklch(0.95 0 0) 58%, transparent)",
      "--selection": "color-mix(in oklab, oklch(0.95 0 0) 24%, transparent)",
      "--info": "oklch(0.72 0.14 245)",
      "--success": "oklch(0.78 0.15 152)",
      "--warning": "oklch(0.83 0.15 78)",
      "--destructive": "oklch(0.7 0.19 25)",
      ...Object.fromEntries(series.dark.map((colour, index) => [`--chart-${index + 1}`, colour])),
      "--shadow": "0 1px 0 oklch(1 0 0 / 0.045) inset, 0 8px 24px -12px oklch(0 0 0 / 0.55)",
      "--shadow-lg": "0 1px 0 oklch(1 0 0 / 0.06) inset, 0 24px 48px -16px oklch(0 0 0 / 0.7)",
    },
  },
  light: {
    mode: "light",
    variables: {
      "--background": "oklch(0.96 0 0)",
      "--foreground": "oklch(0.18 0 0)",
      "--muted-foreground": "oklch(0.38 0 0)",
      "--subtle-foreground": "oklch(0.54 0 0)",
      "--card": "oklch(0.995 0 0 / 0.82)",
      "--card-foreground": "oklch(0.18 0 0)",
      "--popover": "oklch(0.995 0 0 / 0.95)",
      "--popover-foreground": "oklch(0.18 0 0)",
      "--muted": "oklch(0 0 0 / 0.04)",
      "--secondary": "oklch(0 0 0 / 0.07)",
      "--secondary-foreground": "oklch(0.18 0 0)",
      "--accent": "oklch(0 0 0 / 0.07)",
      "--accent-foreground": "oklch(0.18 0 0)",
      "--primary": "oklch(0.2 0 0)",
      "--primary-foreground": "oklch(0.98 0 0)",
      "--primary-soft": "color-mix(in oklab, oklch(0.2 0 0) 9%, transparent)",
      "--border": "oklch(0 0 0 / 0.07)",
      "--border-strong": "oklch(0 0 0 / 0.14)",
      "--input": "oklch(0 0 0 / 0.14)",
      "--ring": "color-mix(in oklab, oklch(0.2 0 0) 55%, transparent)",
      "--selection": "color-mix(in oklab, oklch(0.2 0 0) 16%, transparent)",
      "--info": "oklch(0.56 0.17 250)",
      "--success": "oklch(0.58 0.15 152)",
      "--warning": "oklch(0.68 0.16 65)",
      "--destructive": "oklch(0.56 0.21 25)",
      ...Object.fromEntries(series.light.map((colour, index) => [`--chart-${index + 1}`, colour])),
      "--shadow": "0 1px 0 oklch(1 0 0 / 0.7) inset, 0 8px 24px -12px oklch(0 0 0 / 0.2)",
      "--shadow-lg": "0 1px 0 oklch(1 0 0 / 0.8) inset, 0 24px 48px -16px oklch(0 0 0 / 0.3)",
    },
  },
};

/** What the window looks like behind a page, as an opaque colour: the glass over its backdrop. */
export const BACKDROPS: Readonly<Record<ArtifactMode, string>> = { dark: "#151515", light: "#e8e8e8" };

/** `:root` rules that set a theme, with only names and values a stylesheet can hold. */
export const themeCss = (theme: ArtifactTheme, aliases?: Readonly<Record<string, string>>): string => {
  const clean = (value: string) => value.replace(/[;{}<>]/g, "");
  const named = Object.entries(theme.variables).filter(([name]) => /^--[a-z0-9-]+$/.test(name));
  const rule = (entries: ReadonlyArray<readonly [string, string]>) =>
    entries.map(([name, value]) => `${name}: ${clean(value)};`).join(" ");
  const mode = theme.mode === "light" ? "light" : "dark";
  const own = `:root { color-scheme: ${mode}; ${rule(named)} }`;
  if (aliases === undefined) return own;
  const aliased = named.flatMap(([name, value]) => {
    const token = aliases[name];
    return token === undefined ? [] : [[token, value] as const];
  });
  return `${own}\n:root { ${rule(aliased)} }`;
};
