import type { ToolImageRef } from "@cerium/protocol";

// The image viewer's arithmetic: how far an image may zoom and pan, and where a swipe lands.

/** One image the viewer can show, by whichever way it can be had. */
export interface GalleryImage {
  /** Unique within the gallery, and the same for the image on every render. */
  readonly key: string;
  readonly name: string;
  /** A data URL, when the image is already in the page. */
  readonly url?: string;
  /** Where to read it, when a tool's output left it out of the thread's history. */
  readonly ref?: ToolImageRef;
  /** An absolute path the backend can read, otherwise. */
  readonly path?: string;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * How the image sits on the stage: scaled about its centre from the size that fits it, then moved
 * by `x` and `y` pixels.
 */
export interface View {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export const FIT: View = { scale: 1, x: 0, y: 0 };

/** How far a double tap zooms in, unless the image runs out of pixels first. */
const DOUBLE_TAP_SCALE = 3;

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/**
 * The most the image may be enlarged: to its own pixels, one to one, and at least four times the
 * size that fits, so a small image can still be looked into.
 */
export const maxScaleFor = (natural: Size, fitted: Size): number =>
  fitted.width === 0 ? 1 : Math.max(4, natural.width / fitted.width);

/** The scale a double tap goes to from the fitted view. */
export const doubleTapScaleFor = (maxScale: number): number => Math.min(DOUBLE_TAP_SCALE, maxScale);

/**
 * `view` kept within bounds: no smaller than fitting, no larger than `maxScale`, and moved no
 * further than keeps the image's edges at or beyond the stage's, centred on an axis it doesn't fill.
 */
export const clampView = (view: View, fitted: Size, stage: Size, maxScale: number): View => {
  const scale = clamp(view.scale, 1, maxScale);
  const limitX = Math.max(0, (fitted.width * scale - stage.width) / 2);
  const limitY = Math.max(0, (fitted.height * scale - stage.height) / 2);
  return { scale, x: clamp(view.x, -limitX, limitX), y: clamp(view.y, -limitY, limitY) };
};

/**
 * `view` zoomed to `scale` with the point of the image under `at` (measured from the stage's
 * centre) still under it.
 */
export const zoomAt = (view: View, scale: number, at: Point): View => {
  const ratio = scale / view.scale;
  return { scale, x: at.x - ratio * (at.x - view.x), y: at.y - ratio * (at.y - view.y) };
};

/**
 * Where a horizontal swipe on a fitted image lands: the next image (1), the previous one (-1) or
 * back where it was (0). A fifth of the stage's width or a flick does it.
 */
export const swipeStep = (dx: number, velocity: number, width: number): -1 | 0 | 1 => {
  const far = Math.abs(dx) > width * 0.2;
  const flick = Math.abs(velocity) > 0.4 && Math.abs(dx) > 24 && Math.sign(velocity) === Math.sign(dx);
  if (!far && !flick) return 0;
  return dx < 0 ? 1 : -1;
};

/** Whether a downward swipe on a fitted image closes the viewer: a third of the way or a flick. */
export const swipeCloses = (dy: number, velocity: number, height: number): boolean =>
  dy > height / 3 || (velocity > 0.5 && dy > 40);

/** A drag past the first or last image gives way less and less, so the end is felt. */
export const resist = (offset: number): number => offset / (1 + Math.abs(offset) / 120);
