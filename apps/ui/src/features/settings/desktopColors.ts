import { useSyncExternalStore } from "react";

import { shellBridge } from "../../backend/shell.ts";
import { remember, stored } from "../../lib/storage.ts";

// The Desktop theme's colours, which the desktop shell reads from the system's accent and the
// wallpaper (apps/desktop/src/desktopTheme.ts) and sends again whenever either changes. The last
// ones are remembered, so a window opening in the Desktop theme paints in it before the shell answers.

/** A colour in OKLCH: lightness 0–1, chroma, and hue in degrees. */
export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

export interface DesktopColors {
  readonly accent?: Oklch | undefined;
  readonly wallpaper?: Oklch | undefined;
  /** The wallpaper, small, as a data URL; never remembered. */
  readonly thumbnail?: string | undefined;
}

const KEY = "cerium:desktop-colors";

const asOklch = (value: unknown): Oklch | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { l, c, h } = value as Record<string, unknown>;
  return [l, c, h].every((part) => typeof part === "number" && Number.isFinite(part))
    ? { l: l as number, c: c as number, h: h as number }
    : undefined;
};

/** Colours as the shell sends them, or as they were remembered; undefined when they name none. */
export const asDesktopColors = (value: unknown): DesktopColors | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const accent = asOklch(record["accent"]);
  const wallpaper = asOklch(record["wallpaper"]);
  if (accent === undefined && wallpaper === undefined) return undefined;
  const thumbnail =
    typeof record["thumbnail"] === "string" && record["thumbnail"].startsWith("data:image/")
      ? record["thumbnail"]
      : undefined;
  return { accent, wallpaper, thumbnail };
};

const recalled = (): DesktopColors | undefined => {
  try {
    return asDesktopColors(JSON.parse(stored(KEY) ?? "null"));
  } catch {
    return undefined;
  }
};

/** The colours now; null until first asked for, when the remembered ones stand in. */
let current: DesktopColors | undefined | null = null;
const snapshot = () => {
  current ??= shellBridge()?.desktopColors === undefined ? undefined : recalled();
  return current;
};
const listeners = new Set<() => void>();
let following = false;

const accept = (value: unknown) => {
  const next = asDesktopColors(value);
  current = next;
  if (next !== undefined) remember(KEY, JSON.stringify({ accent: next.accent, wallpaper: next.wallpaper }));
  for (const listener of listeners) listener();
};

const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  const bridge = shellBridge();
  if (!following && bridge?.desktopColors !== undefined) {
    following = true;
    void bridge.desktopColors().then(accept, () => undefined);
    bridge.onDesktopColorsChange?.(accept);
  }
  return () => listeners.delete(onChange);
};

/** The desktop's colours, once the shell has said them (or remembered from last time); undefined outside it. */
export const useDesktopColors = () => useSyncExternalStore(subscribe, snapshot);

/** How far apart two hues are, either way round. */
const apart = (one: number, other: number) => {
  const difference = Math.abs(one - other) % 360;
  return Math.min(difference, 360 - difference);
};

/** Status hues that an accent this close to would be mistaken for are turned this far from it. */
const STATUS_GAP = 35;

/**
 * How many degrees to turn a status's hue so it isn't mistaken for the accent, as the shipped themes
 * do by hand: a blue accent pushes "running" towards cyan. None when they're already far enough apart.
 */
export const statusTurn = (hue: number, accent: Oklch) => {
  if (accent.c < 0.05 || apart(hue, accent.h) >= STATUS_GAP) return 0;
  const side = ((hue - accent.h + 540) % 360) - 180;
  return (side >= 0 ? STATUS_GAP : -STATUS_GAP) - side;
};

/** The hue tokens.css gives each status in dark mode; the Desktop theme turns both modes' alike. */
const STATUSES = { running: 245, attention: 78, error: 25, success: 152 } as const;

/**
 * The custom properties the Desktop theme (styles/themes.css) is drawn from: the wallpaper tints the
 * glass and the accent colours the accent, each standing in for the other where the system gives only
 * one. Set on the root whatever the theme, so Settings can draw the Desktop sample beside the others.
 */
export const desktopProperties = (colors: DesktopColors): Record<string, string> => {
  const accent = (colors.accent ?? colors.wallpaper)!;
  const tint = colors.wallpaper ?? { ...accent, c: accent.c * 0.25 };
  const round = (value: number, places: number) => String(Number(value.toFixed(places)));
  return {
    "--desktop-tint-h": round(tint.h, 1),
    "--desktop-tint-c": round(tint.c, 4),
    "--desktop-accent-h": round(accent.h, 1),
    "--desktop-accent-c": round(accent.c, 4),
    ...Object.fromEntries(
      Object.entries(STATUSES).map(([status, hue]) => [
        `--desktop-${status}-turn`,
        round(statusTurn(hue, accent), 1),
      ]),
    ),
  };
};
