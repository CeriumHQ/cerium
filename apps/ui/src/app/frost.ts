import {
  PolishGrid,
  breath,
  fogFactor,
  isEmpty,
  revealLength,
  revealStrokes,
  seeded,
  union,
  type CellBounds,
  type RevealLine,
} from "./polish.ts";

/**
 * A new thread's frosted glass (app/EmptyThread.tsx): a breath fogging the pane over its question,
 * which shows through blurred. The pointer polishes the glass clear where it passes, typing in the
 * message box wipes the question clear a letter at a time, and the fog comes back over what's left
 * alone. The fog thins out before the pane's edges, so the pane meets the sidebar and the title bar as
 * a thread's transcript does, whatever the theme and whether or not the window lets the desktop through.
 *
 * One canvas draws it all. The glass, frosted, is drawn once per size and theme; each frame cuts the
 * polish out of it and lays the question, sharp, into the cut. The polish is a coarse grid of numbers
 * (app/polish.ts), so the fog fades back smoothly instead of in a canvas's 8-bit steps.
 */

/** The question as the page laid it out, one line at a time, in CSS pixels from the glass's corner. */
export interface SceneLine {
  readonly text: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** What the glass draws: its size, the question's lines and type, and the theme's frost. */
export interface FrostScene {
  readonly width: number;
  readonly height: number;
  /** Device pixels to a CSS pixel. */
  readonly scale: number;
  /** The question's type, as a canvas font. */
  readonly font: string;
  readonly stretch: CanvasFontStretch;
  readonly letterSpacing: string;
  /** The question's size, in CSS pixels. */
  readonly size: number;
  readonly lines: ReadonlyArray<SceneLine>;
  /** Where the message box's top sits under the question, in CSS pixels from the glass's top: no fog below. */
  readonly floor: number;
  readonly colors: {
    /** The question through clear glass. */
    readonly text: string;
    /** The question through the frost. */
    readonly blur: string;
    readonly haze: string;
    readonly rim: string;
  };
}

/** Canvas names for the widths CSS gives as percentages. */
const STRETCHES: Readonly<Record<string, CanvasFontStretch>> = {
  "50%": "ultra-condensed",
  "62.5%": "extra-condensed",
  "75%": "condensed",
  "87.5%": "semi-condensed",
  "100%": "normal",
  "112.5%": "semi-expanded",
  "125%": "expanded",
  "150%": "extra-expanded",
  "200%": "ultra-expanded",
};

/**
 * Reads the scene from the page: `headline`'s lines, each a child element, as laid out over `glass`,
 * and the frost tokens, with the fog kept above `floor`, in the window's coordinates. Undefined while
 * the glass has no size.
 */
export const readScene = (
  glass: HTMLElement,
  headline: HTMLElement,
  floor?: number,
): FrostScene | undefined => {
  const box = glass.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return undefined;
  const style = getComputedStyle(headline);
  const lines = [...headline.children].flatMap((child): ReadonlyArray<SceneLine> => {
    const text = child.textContent ?? "";
    if (text === "") return [];
    const range = document.createRange();
    range.selectNodeContents(child);
    const rect = range.getBoundingClientRect();
    return [
      { text, left: rect.left - box.left, top: rect.top - box.top, width: rect.width, height: rect.height },
    ];
  });
  // A token resolved to a colour a canvas can take.
  const probe = document.createElement("span");
  glass.append(probe);
  const color = (token: string) => {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };
  const colors = {
    text: color("--fg-primary"),
    blur: color("--frost-text"),
    haze: color("--frost-haze"),
    rim: color("--frost-rim"),
  };
  probe.remove();
  return {
    width: box.width,
    height: box.height,
    scale: Math.min(2, window.devicePixelRatio || 1),
    font: `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
    stretch: STRETCHES[style.fontStretch] ?? "normal",
    letterSpacing: style.letterSpacing === "normal" ? "0px" : style.letterSpacing,
    size: Number.parseFloat(style.fontSize),
    lines,
    floor: floor === undefined ? box.height : floor - box.top,
    colors,
  };
};

type Point = { readonly x: number; readonly y: number };
type Rgba = readonly [number, number, number, number];

/** How wide the pointer's cloth is, against the question's size. */
const clothRadius = (size: number) => Math.min(64, Math.max(30, size * 0.55));
/** How much one touch of the pointer's cloth clears, and how often it touches down. */
const RUB_STRENGTH = 0.16;
const RUB_SPACING = 4;
/**
 * How much fog a wipe piles up at its edge, per cell the cloth spans: a smaller cloth's edge is steeper,
 * so its rim would otherwise read as an outline.
 */
const RIM_GAIN = 0.16;
/** How quickly the wipe typing makes catches up with the typing, in milliseconds. */
const REVEAL_EASE_MS = 80;
/** The first wipe over a new thread's question: how long it takes and how far along its first line. */
const SWEEP_MS = 1_150;
const SWEEP_REACH = 0.72;
/** The cloth stays in view this long after the pointer stops. */
const CLOTH_LINGER_MS = 900;
/**
 * The least change the fog's return is painted for: half a step of a canvas's 8-bit colour, on the
 * question's letters, where clearness shows most. Over a little that's still clear the fog changes
 * the glass by less than that from one frame to the next, so most of its long tail paints nothing new.
 */
const HALF_STEP = 0.5 / 255;

/** A CSS colour as its 0–255 channels and 0–1 alpha. */
const channels = (color: string): Rgba => {
  const canvas = new OffscreenCanvas(1, 1);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return [255, 255, 255, 0];
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r = 255, g = 255, b = 255, a = 0] = context.getImageData(0, 0, 1, 1).data;
  return [r, g, b, a / 255];
};

const rgba = ([r, g, b]: Rgba, alpha: number) => `rgba(${r} ${g} ${b} / ${alpha})`;

/** Where each line's baseline sits, for `context`'s font. */
const baselineOf = (context: OffscreenCanvasRenderingContext2D, line: SceneLine) => {
  const metrics = context.measureText(line.text);
  const ascent = metrics.fontBoundingBoxAscent;
  const descent = metrics.fontBoundingBoxDescent;
  return line.top + (line.height - (ascent + descent)) / 2 + ascent;
};

const setFont = (context: OffscreenCanvasRenderingContext2D, scene: FrostScene) => {
  context.font = scene.font;
  context.fontStretch = scene.stretch;
  context.letterSpacing = scene.letterSpacing;
  context.fontKerning = "normal";
  context.textBaseline = "alphabetic";
};

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** The glass's drawing, made for one scene. */
interface Drawn {
  readonly scene: FrostScene;
  /** The whole glass, frosted, in device pixels. */
  readonly frost: OffscreenCanvas;
  /** The question as clear glass shows it, over `box`. */
  readonly sharp: OffscreenCanvas;
  /** The sharp question cut to the polish, each frame. */
  readonly cut: OffscreenCanvasRenderingContext2D;
  /** Where `sharp` sits on the glass, in device pixels. */
  readonly box: { readonly x: number; readonly y: number };
  /** The polish as an image, a pixel to a cell: its alpha is how clear each cell is. */
  readonly mask: OffscreenCanvasRenderingContext2D;
  readonly maskImage: ImageData;
  /** The fog piled up at a wipe's edge, likewise. */
  readonly rim: OffscreenCanvasRenderingContext2D;
  readonly rimImage: ImageData;
  readonly rimColor: Rgba;
  /** How much a cell's steepness piles up its rim. */
  readonly rimGain: number;
  /** How thick the fog lies over each polish cell, 0 to 1. */
  readonly fog: Float32Array;
  /** The question's lines, for typing to wipe along. */
  readonly reveal: ReadonlyArray<RevealLine>;
}

export class Frost {
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  readonly #glass: HTMLElement;
  readonly #cloth: HTMLElement;
  readonly #reduceMotion: boolean;
  /** Shapes this pane's fog, the same each time it's redrawn. */
  readonly #seed = Math.floor(Math.random() * 2 ** 32);
  #drawn: Drawn | undefined;
  /** What the pointer polished, which the fog takes back. */
  #rubbed = new PolishGrid(1, 1);
  /** What typing wiped, which holds while the message box has the text. */
  #typed = new PolishGrid(1, 1);
  /** The cells drawn clear last frame, cleared from the mask once the fog has them. */
  #painted: CellBounds = { left: 0, top: 0, right: 0, bottom: 0 };
  /** The clearest the pointer's polish was when last painted, and what the fog has kept of it since. */
  #paintedPeak = 0;
  #fadedSince = 1;
  #revealTarget = 0;
  #revealShown = 0;
  #rubbedAt = Number.NEGATIVE_INFINITY;
  #last: Point | undefined;
  #sweepFrom: number | undefined;
  #sweepAt: Point | undefined;
  #greeted = false;
  #changed = true;
  #frame = 0;
  #tickedAt = 0;
  #clothTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #listeners: ReadonlyArray<readonly [string, (event: PointerEvent) => void]>;

  constructor(canvas: HTMLCanvasElement, glass: HTMLElement, cloth: HTMLElement, reduceMotion: boolean) {
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("The frosted glass needs a 2D canvas");
    this.#canvas = canvas;
    this.#context = context;
    this.#glass = glass;
    this.#cloth = cloth;
    this.#reduceMotion = reduceMotion;
    this.#listeners = [
      ["pointerdown", this.#onDown],
      ["pointermove", this.#onMove],
      ["pointerup", this.#onLift],
      ["pointerleave", this.#onLift],
      ["pointercancel", this.#onLift],
    ];
    for (const [type, listener] of this.#listeners) glass.addEventListener(type, listener as EventListener);
  }

  /** Draws the glass for `scene`, keeping what's polished when its size stays. */
  show(scene: FrostScene): void {
    const previous = this.#drawn?.scene;
    const resized =
      previous === undefined ||
      previous.width !== scene.width ||
      previous.height !== scene.height ||
      previous.scale !== scene.scale;
    const width = Math.round(scene.width * scene.scale);
    const height = Math.round(scene.height * scene.scale);
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }
    const held = this.#canvas.style;
    held.width = held.height = held.left = held.top = held.transform = held.transformOrigin = "";
    if (resized) {
      this.#rubbed = new PolishGrid(scene.width, scene.height);
      this.#typed = new PolishGrid(scene.width, scene.height);
    }
    this.#drawn = draw(scene, this.#rubbed, this.#seed);
    this.#painted = { left: 0, top: 0, right: this.#rubbed.cols, bottom: this.#rubbed.rows };
    // The question may have moved: typing's wipe is laid along it again, at once.
    this.#typed.reset();
    this.#revealShown = 0;
    this.#wipeTyped(this.#revealTarget);
    this.#changed = true;
    this.#paint();
    this.#wake();
  }

  /**
   * The glass is being resized away from the size it was drawn for. Drawing it takes longer than a
   * frame, so until it's shown again its drawing is scaled and moved onto the question as `headline`
   * now lays it out, and the question resizes with the pane instead of jumping once it settles; what
   * the pane gains at its edges is clear glass anyway.
   */
  hold(headline: HTMLElement): void {
    const scene = this.#drawn?.scene;
    const drawn = scene?.lines[0];
    const line = headline.firstElementChild;
    if (scene === undefined || drawn === undefined || line === null) return;
    const range = document.createRange();
    range.selectNodeContents(line);
    const now = range.getBoundingClientRect();
    const box = this.#glass.getBoundingClientRect();
    const scale = Number.parseFloat(getComputedStyle(headline).fontSize) / scene.size;
    const x = now.left - box.left - drawn.left * scale;
    const y = now.top - box.top - drawn.top * scale;
    const held = this.#canvas.style;
    held.width = `${scene.width}px`;
    held.height = `${scene.height}px`;
    held.left = held.top = "0px";
    held.transformOrigin = "0 0";
    held.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }

  /**
   * The message box holds `chars` characters: the question is wiped clear through as many of its own.
   * A wipe typing takes back is left to the fog.
   */
  reveal(chars: number): void {
    const target = Math.max(0, chars);
    if (target === this.#revealTarget) return;
    if (target < this.#revealShown) {
      this.#rubbed.absorb(this.#typed);
      this.#rubbedAt = performance.now();
      this.#typed.reset();
      this.#revealShown = 0;
      this.#revealTarget = target;
      this.#wipeTyped(target);
    } else {
      this.#revealTarget = target;
      if (this.#reduceMotion) this.#wipeTyped(target);
    }
    this.#changed = true;
    this.#wake();
  }

  /** The glass first shows: unless typing already cleared it, a cloth wipes once across the question. */
  greet(): void {
    if (this.#greeted) return;
    this.#greeted = true;
    if (this.#reduceMotion || this.#revealTarget > 0) return;
    // It starts on the first frame the glass draws, which may wait on the question's font.
    this.#sweepFrom = Number.NaN;
    this.#sweepAt = undefined;
    this.#wake();
  }

  dispose(): void {
    cancelAnimationFrame(this.#frame);
    clearTimeout(this.#clothTimer);
    for (const [type, listener] of this.#listeners) {
      this.#glass.removeEventListener(type, listener as EventListener);
    }
  }

  #local(event: PointerEvent): Point {
    const box = this.#glass.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  readonly #onDown = (event: PointerEvent) => {
    if (event.pointerType === "touch") this.#last = this.#local(event);
  };

  readonly #onMove = (event: PointerEvent) => {
    const drawn = this.#drawn;
    if (drawn === undefined) return;
    const radius = clothRadius(drawn.scene.size);
    // Every sample the pointer took since the last frame, so a fast stroke stays one smooth wipe.
    const samples = event.getCoalescedEvents?.() ?? [];
    for (const sample of samples.length > 0 ? samples : [event]) {
      const point = this.#local(sample);
      if (this.#last === undefined) this.#rubbed.dab(point.x, point.y, radius, RUB_STRENGTH);
      else this.#rubbed.rub(this.#last, point, radius, RUB_STRENGTH, RUB_SPACING);
      this.#last = point;
    }
    this.#rubbedAt = performance.now();
    this.#changed = true;
    if (event.pointerType !== "touch" && this.#last !== undefined) {
      this.#showCloth(this.#last, radius, this.#fogAt(drawn, this.#last));
    }
    this.#wake();
  };

  /** How thick the fog lies at `point`. */
  #fogAt(drawn: Drawn, point: Point): number {
    const { cell, cols, rows } = this.#rubbed;
    const col = Math.floor(point.x / cell);
    const row = Math.floor(point.y / cell);
    if (col < 0 || row < 0 || col >= cols || row >= rows) return 0;
    return drawn.fog[row * cols + col] ?? 0;
  }

  readonly #onLift = () => {
    this.#last = undefined;
    this.#hideCloth();
  };

  /** The cloth at `at`, as plain as the fog it's over is thick: on clear glass there's nothing to polish. */
  #showCloth(at: Point, radius: number, fog: number) {
    const cloth = this.#cloth;
    cloth.style.width = cloth.style.height = `${radius * 2}px`;
    cloth.style.translate = `${at.x - radius}px ${at.y - radius}px`;
    cloth.style.setProperty("--fog", String(Math.min(1, fog * 1.5)));
    cloth.dataset["on"] = "";
    clearTimeout(this.#clothTimer);
    this.#clothTimer = setTimeout(() => this.#hideCloth(), CLOTH_LINGER_MS);
  }

  #hideCloth() {
    clearTimeout(this.#clothTimer);
    delete this.#cloth.dataset["on"];
  }

  /** Lays typing's wipe along the question from where it reached to `chars`. */
  #wipeTyped(chars: number) {
    const drawn = this.#drawn;
    if (drawn === undefined) return;
    const { size } = drawn.scene;
    const total = revealLength(drawn.reveal);
    const from = Math.min(this.#revealShown, total);
    const to = Math.min(chars, total);
    this.#revealShown = chars;
    if (to <= from) return;
    // A hand's wipe, just taller than the letters: it rides up and down a little as it goes.
    const radius = size * 0.56;
    const wobble = size * 0.07;
    const period = size * 0.9;
    const spacing = Math.max(2, size * 0.07);
    const wipe = (x: number, y: number) => this.#typed.dab(x, y + Math.sin(x / period) * wobble, radius, 0.4);
    for (const stroke of revealStrokes(drawn.reveal, from, to, size * 0.3)) {
      for (let x = stroke.from; x < stroke.to; x += spacing) wipe(x, stroke.y);
      wipe(stroke.to, stroke.y);
    }
  }

  #wake() {
    if (this.#frame !== 0 || this.#drawn === undefined) return;
    this.#tickedAt = performance.now();
    this.#frame = requestAnimationFrame(this.#tick);
  }

  readonly #tick = (now: number) => {
    this.#frame = 0;
    const elapsed = Math.min(64, Math.max(0, now - this.#tickedAt));
    this.#tickedAt = now;
    let busy = false;
    if (this.#sweepFrom !== undefined) busy = this.#sweep(now) || busy;
    if (this.#revealShown < this.#revealTarget) {
      const gap = this.#revealTarget - this.#revealShown;
      const step = gap * (1 - Math.exp(-elapsed / REVEAL_EASE_MS));
      this.#wipeTyped(gap - step < 0.02 ? this.#revealTarget : this.#revealShown + step);
      this.#changed = true;
      busy = true;
    }
    if (this.#rubbed.clear) {
      const factor = fogFactor(now - this.#rubbedAt, elapsed);
      if (factor < 1) {
        this.#rubbed.fog(factor);
        this.#fadedSince *= factor;
        const change = this.#paintedPeak * (1 - this.#fadedSince);
        if (change >= HALF_STEP || !this.#rubbed.clear) this.#changed = true;
      }
      busy = busy || this.#rubbed.clear;
    }
    if (this.#changed) this.#paint();
    if (busy) this.#frame = requestAnimationFrame(this.#tick);
  };

  /** The first wipe, along the question's first line and back up; whether it's still going. */
  #sweep(now: number): boolean {
    const drawn = this.#drawn;
    const line = drawn?.scene.lines[0];
    if (drawn === undefined || line === undefined || this.#sweepFrom === undefined) return false;
    const { size } = drawn.scene;
    if (Number.isNaN(this.#sweepFrom)) this.#sweepFrom = now;
    const t = Math.min(1, (now - this.#sweepFrom) / SWEEP_MS);
    const along = easeOut(t);
    const middle = drawn.reveal[0]?.middle ?? line.top + line.height / 2;
    const point = {
      x: line.left - size * 0.4 + (line.width + size * 0.4) * SWEEP_REACH * along,
      y: middle + Math.sin(along * Math.PI * 2.5) * size * 0.22,
    };
    const radius = clothRadius(size) * 1.1;
    if (this.#sweepAt === undefined) this.#rubbed.dab(point.x, point.y, radius, 0.22);
    else this.#rubbed.rub(this.#sweepAt, point, radius, 0.22, RUB_SPACING);
    this.#sweepAt = point;
    this.#rubbedAt = now;
    this.#changed = true;
    if (t < 1) return true;
    this.#sweepFrom = undefined;
    this.#sweepAt = undefined;
    return false;
  }

  #paint() {
    const drawn = this.#drawn;
    if (drawn === undefined) return;
    this.#changed = false;
    const context = this.#context;
    const { scale } = drawn.scene;
    const rubbed = this.#rubbed;
    const typed = this.#typed;
    this.#paintedPeak = rubbed.peak;
    this.#fadedSince = 1;
    const clear = union(rubbed.bounds, typed.bounds);
    const stale = union(clear, this.#painted);
    this.#painted = clear;
    if (!isEmpty(stale)) writeMasks(drawn, rubbed, typed, stale);

    context.globalCompositeOperation = "copy";
    context.drawImage(drawn.frost, 0, 0);
    context.globalCompositeOperation = "source-over";
    if (isEmpty(clear)) return;

    const cell = rubbed.cell * scale;
    const width = rubbed.cols * cell;
    const height = rubbed.rows * cell;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    // The polish wiped out of the frost, a little fog piled at its edges, and the question laid in sharp.
    context.globalCompositeOperation = "destination-out";
    context.drawImage(drawn.mask.canvas, 0, 0, width, height);
    context.globalCompositeOperation = "source-over";
    context.drawImage(drawn.rim.canvas, 0, 0, width, height);
    const cut = drawn.cut;
    cut.globalCompositeOperation = "copy";
    cut.drawImage(drawn.sharp, 0, 0);
    cut.globalCompositeOperation = "destination-in";
    cut.imageSmoothingEnabled = true;
    cut.imageSmoothingQuality = "high";
    cut.drawImage(drawn.mask.canvas, -drawn.box.x, -drawn.box.y, width, height);
    context.drawImage(cut.canvas, drawn.box.x, drawn.box.y);
  }
}

/** The mask and rim images over `bounds`, from both polishes. */
const writeMasks = (drawn: Drawn, rubbed: PolishGrid, typed: PolishGrid, bounds: CellBounds) => {
  const { cols, rows } = rubbed;
  const left = Math.max(0, bounds.left - 1);
  const top = Math.max(0, bounds.top - 1);
  const right = Math.min(cols, bounds.right + 1);
  const bottom = Math.min(rows, bounds.bottom + 1);
  const mask = drawn.maskImage.data;
  const rim = drawn.rimImage.data;
  const [r, g, b, alpha] = drawn.rimColor;
  const fog = drawn.fog;
  const at = (col: number, row: number) => Math.max(rubbed.at(col, row), typed.at(col, row));
  for (let row = top; row < bottom; row++) {
    for (let col = left; col < right; col++) {
      const value = at(col, row);
      const slope =
        Math.abs(at(col + 1, row) - at(col - 1, row)) + Math.abs(at(col, row + 1) - at(col, row - 1));
      const cell = row * cols + col;
      const index = cell * 4;
      mask[index + 3] = value * 255;
      rim[index] = r;
      rim[index + 1] = g;
      rim[index + 2] = b;
      // Only fog that's there piles up.
      rim[index + 3] = Math.min(1, slope * drawn.rimGain) * (1 - value) * (fog[cell] ?? 0) * alpha * 255;
    }
  }
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return;
  drawn.mask.putImageData(drawn.maskImage, 0, 0, left, top, width, height);
  drawn.rim.putImageData(drawn.rimImage, 0, 0, left, top, width, height);
};

/** A grain tile: specks of haze, so a large frosted pane doesn't read as flat. */
const grain = (haze: Rgba): OffscreenCanvas => {
  const size = 160;
  const tile = new OffscreenCanvas(size, size);
  const context = tile.getContext("2d");
  if (context === null) return tile;
  const image = context.createImageData(size, size);
  const [r, g, b, a] = haze;
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = r;
    image.data[index + 1] = g;
    image.data[index + 2] = b;
    image.data[index + 3] = Math.random() ** 3 * Math.min(1, a * 1.3) * 255;
  }
  context.putImageData(image, 0, 0);
  return tile;
};

/** Everything the glass draws from, for one scene, its fog shaped by `seed`. */
const draw = (scene: FrostScene, grid: PolishGrid, seed: number): Drawn => {
  const { width, height, scale, size, colors } = scene;
  const random = seeded(seed);
  const haze = channels(colors.haze);
  const frost = new OffscreenCanvas(Math.round(width * scale), Math.round(height * scale));
  const glass = frost.getContext("2d");
  if (glass === null) throw new Error("The frosted glass needs a 2D canvas");
  glass.scale(scale, scale);
  const question = {
    left: Math.min(...scene.lines.map((line) => line.left)),
    top: Math.min(...scene.lines.map((line) => line.top)),
    right: Math.max(...scene.lines.map((line) => line.left + line.width)),
    bottom: Math.max(...scene.lines.map((line) => line.top + line.height)),
  };

  // The haze, thicker in drifts, and the condensation's beads.
  glass.fillStyle = colors.haze;
  glass.fillRect(0, 0, width, height);
  const reach = Math.max(width, height);
  const drifts = 4 + Math.round((width * height) / 260_000);
  for (let drift = 0; drift < drifts; drift++) {
    const x = random() * width;
    const y = random() * height;
    const radius = reach * (0.18 + random() * 0.32);
    const gradient = glass.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, rgba(haze, haze[3]));
    gradient.addColorStop(1, rgba(haze, 0));
    glass.globalAlpha = 0.3 + random() * 0.5;
    glass.fillStyle = gradient;
    glass.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  glass.globalAlpha = 1;
  // The grain is as fine as the screen: a speck to a device pixel.
  const pattern = glass.createPattern(grain(haze), "repeat");
  if (pattern !== null) {
    glass.save();
    glass.setTransform(1, 0, 0, 1, 0, 0);
    glass.fillStyle = pattern;
    glass.fillRect(0, 0, frost.width, frost.height);
    glass.restore();
  }
  const beads = Math.round((width * height) / 4_000);
  glass.fillStyle = rgba(haze, Math.min(1, haze[3] * 2.2));
  for (let bead = 0; bead < beads; bead++) {
    const radius = 0.3 + random() ** 5 * 1.4;
    glass.globalAlpha = 0.2 + random() * 0.6;
    glass.beginPath();
    glass.arc(random() * width, random() * height, radius, 0, Math.PI * 2);
    glass.fill();
  }
  glass.globalAlpha = 1;

  // All of it gathered into a breath's patch over the question, gone before the pane's edges.
  const fog = breath(grid, width, height, question, size, random, scene.floor);
  const shape = new OffscreenCanvas(grid.cols, grid.rows);
  const shaping = shape.getContext("2d");
  if (shaping === null) throw new Error("The frosted glass needs a 2D canvas");
  const thickness = shaping.createImageData(grid.cols, grid.rows);
  fog.forEach((value, cell) => {
    thickness.data[cell * 4 + 3] = value * 255;
  });
  shaping.putImageData(thickness, 0, 0);
  glass.imageSmoothingEnabled = true;
  glass.imageSmoothingQuality = "high";
  glass.globalCompositeOperation = "destination-in";
  glass.drawImage(shape, 0, 0, grid.cols * grid.cell, grid.rows * grid.cell);
  glass.globalCompositeOperation = "source-over";

  // The question through the frost: a faint wide glow of it, and nearer, its shapes softened. The glow
  // stays faint: it's white, and over a coloured desktop a strong one reads as a grey smudge.
  setFont(glass, scene);
  glass.fillStyle = colors.blur;
  const baselines = scene.lines.map((line) => baselineOf(glass, line));
  for (const [blur, alpha] of [
    [size * 0.17, 0.12],
    [size * 0.06, 0.82],
  ] as const) {
    glass.filter = `blur(${blur}px)`;
    glass.globalAlpha = alpha;
    scene.lines.forEach((line, index) => glass.fillText(line.text, line.left, baselines[index] ?? 0));
  }
  glass.filter = "none";
  glass.globalAlpha = 1;

  // The question through clear glass, over the box its lines take with room for every glyph.
  const margin = size * 0.35;
  const left = question.left - margin;
  const top = question.top - margin;
  const right = question.right + margin;
  const bottom = question.bottom + margin;
  const box = { x: Math.max(0, Math.floor(left * scale)), y: Math.max(0, Math.floor(top * scale)) };
  const sharp = new OffscreenCanvas(
    Math.max(1, Math.ceil(right * scale) - box.x),
    Math.max(1, Math.ceil(bottom * scale) - box.y),
  );
  const text = sharp.getContext("2d");
  const cut = new OffscreenCanvas(sharp.width, sharp.height).getContext("2d");
  if (text === null || cut === null) throw new Error("The frosted glass needs a 2D canvas");
  text.translate(-box.x, -box.y);
  text.scale(scale, scale);
  setFont(text, scene);
  text.fillStyle = colors.text;
  scene.lines.forEach((line, index) => text.fillText(line.text, line.left, baselines[index] ?? 0));

  // Typing wipes through the middle of each line's capitals, character by character.
  const capital = text.measureText("H").actualBoundingBoxAscent;
  const reveal = scene.lines.map((line, index): RevealLine => {
    // By UTF-16 unit, as the message box's text is counted.
    const ends = Array.from(
      { length: line.text.length },
      (_, end) => text.measureText(line.text.slice(0, end + 1)).width,
    );
    return { left: line.left, middle: (baselines[index] ?? 0) - capital / 2, ends };
  });

  const mask = new OffscreenCanvas(grid.cols, grid.rows).getContext("2d");
  const rim = new OffscreenCanvas(grid.cols, grid.rows).getContext("2d");
  if (mask === null || rim === null) throw new Error("The frosted glass needs a 2D canvas");
  return {
    scene,
    frost,
    sharp,
    cut,
    box,
    mask,
    maskImage: mask.createImageData(grid.cols, grid.rows),
    rim,
    rimImage: rim.createImageData(grid.cols, grid.rows),
    rimColor: channels(colors.rim),
    rimGain: (RIM_GAIN * clothRadius(size)) / grid.cell,
    fog,
    reveal,
  };
};
