// The colours the Desktop theme takes from the user's desktop, worked out in OKLCH, the space the UI's
// tokens are written in: the system's accent colour, and the wallpaper's own colour. Pure, so the
// shell's reading of the desktop (desktopTheme.ts) stays thin.

/** A colour in OKLCH: lightness 0–1, chroma, and hue in degrees. */
export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

/** What the Desktop theme is drawn from; each part only where the system gives it. */
export interface DesktopColors {
  /** The accent colour the user picked for the system (or Windows picked from the wallpaper). */
  readonly accent?: Oklch | undefined;
  /** The wallpaper's colour: the hue most of its colour is, and how colourful the whole picture is. */
  readonly wallpaper?: Oklch | undefined;
  /** The wallpaper, small, as a JPEG data URL, for the theme's sample in Settings. */
  readonly thumbnail?: string | undefined;
}

const linear = (channel: number) => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

/** An sRGB colour (channels 0–255) in OKLab. */
export const oklab = (red: number, green: number, blue: number): readonly [number, number, number] => {
  const r = linear(red);
  const g = linear(green);
  const b = linear(blue);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};

const hueOf = (a: number, b: number) => {
  const degrees = (Math.atan2(b, a) * 180) / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
};

/** A colour as the system writes it, `RRGGBB` or `RRGGBBAA` with or without a `#`, in OKLCH. */
export const oklchFromHex = (hex: string): Oklch | undefined => {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})(?:[\da-f]{2})?$/i.exec(hex.trim());
  if (match === null) return undefined;
  const [red, green, blue] = [match[1]!, match[2]!, match[3]!].map((part) => parseInt(part, 16));
  const [l, a, b] = oklab(red!, green!, blue!);
  return { l, c: Math.hypot(a, b), h: hueOf(a, b) };
};

/** Hue bins a wallpaper's pixels are sorted into, 10° each. */
const BINS = 36;

/**
 * The colour of a picture, from its raw pixels (`BGRA`, as Chromium's bitmaps are): the hue that most
 * of its colour lies around, and its chroma averaged over every pixel, greys counting as none, so a
 * grey photo with one red door comes out a faint red and a field of poppies a strong one. Undefined
 * for a picture with no opaque pixels.
 */
export const dominantColor = (pixels: Uint8Array): Oklch | undefined => {
  const chroma = new Float64Array(BINS);
  const sumA = new Float64Array(BINS);
  const sumB = new Float64Array(BINS);
  const sumL = new Float64Array(BINS);
  let count = 0;
  let lightness = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    if (pixels[index + 3]! < 128) continue;
    const [l, a, b] = oklab(pixels[index + 2]!, pixels[index + 1]!, pixels[index]!);
    const c = Math.hypot(a, b);
    const bin = Math.floor(hueOf(a, b) / (360 / BINS)) % BINS;
    chroma[bin]! += c;
    sumA[bin]! += a;
    sumB[bin]! += b;
    sumL[bin]! += l * c;
    count += 1;
    lightness += l;
  }
  if (count === 0) return undefined;

  // The strongest run of three neighbouring bins, so a hue on a bin's edge isn't split in two.
  const around = (bin: number) => [(bin + BINS - 1) % BINS, bin, (bin + 1) % BINS];
  const strength = (bin: number) => around(bin).reduce((sum, each) => sum + chroma[each]!, 0);
  let best = 0;
  for (let bin = 1; bin < BINS; bin += 1) if (strength(bin) > strength(best)) best = bin;

  const bins = around(best);
  const a = bins.reduce((sum, each) => sum + sumA[each]!, 0);
  const b = bins.reduce((sum, each) => sum + sumB[each]!, 0);
  const weight = strength(best);
  return {
    l: weight > 0 ? bins.reduce((sum, each) => sum + sumL[each]!, 0) / weight : lightness / count,
    c: Math.hypot(a, b) / count,
    h: hueOf(a, b),
  };
};
