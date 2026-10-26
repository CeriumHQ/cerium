/**
 * How a new thread's frosted glass is polished (app/frost.ts draws it): a grid over the glass whose
 * cells run from 0, frosted, to 1, polished clear; the fog that comes back over it; and the path typing
 * wipes along the question. Plain numbers, so the canvas only draws what this decides.
 */

/** A grid cell's side, in CSS pixels: fine enough that a scaled-up grid reads as a soft cloth. */
export const POLISH_CELL = 4;

/** Clearness below this is fog again: under three steps of a canvas's alpha. */
const EPSILON = 0.01;

/** How long a wipe stays clear after the cloth leaves it, before the fog starts back. */
export const FOG_HOLD_MS = 700;
/** How long the fog takes to come back in full force once it starts. */
export const FOG_ONSET_MS = 1_200;
/** At full force, the fog takes back half of what's still clear every this long. */
export const FOG_HALF_LIFE_MS = 2_000;

/**
 * What a cell keeps of its clearness over `elapsed` milliseconds, `since` milliseconds after the last
 * rub: all of it while the wipe holds, then less as the fog comes on.
 */
export const fogFactor = (since: number, elapsed: number): number => {
  if (since <= FOG_HOLD_MS || elapsed <= 0) return 1;
  const force = Math.min(1, (since - FOG_HOLD_MS) / FOG_ONSET_MS);
  return 0.5 ** ((elapsed / FOG_HALF_LIFE_MS) * force);
};

/** The cells that may be clear, `[left, right)` by `[top, bottom)`; empty when right <= left. */
export interface CellBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

const NONE: CellBounds = { left: 0, top: 0, right: 0, bottom: 0 };

export const isEmpty = (bounds: CellBounds): boolean =>
  bounds.right <= bounds.left || bounds.bottom <= bounds.top;

/** The smallest bounds holding both. */
export const union = (a: CellBounds, b: CellBounds): CellBounds =>
  isEmpty(a)
    ? b
    : isEmpty(b)
      ? a
      : {
          left: Math.min(a.left, b.left),
          top: Math.min(a.top, b.top),
          right: Math.max(a.right, b.right),
          bottom: Math.max(a.bottom, b.bottom),
        };

/** The glass, cell by cell: how clear each is, and where any clear ones are. */
export class PolishGrid {
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  readonly values: Float32Array;
  #bounds: CellBounds = NONE;

  /** A frosted grid over `width` by `height` CSS pixels. */
  constructor(width: number, height: number, cell: number = POLISH_CELL) {
    this.cell = cell;
    this.cols = Math.max(1, Math.ceil(width / cell));
    this.rows = Math.max(1, Math.ceil(height / cell));
    this.values = new Float32Array(this.cols * this.rows);
  }

  get bounds(): CellBounds {
    return this.#bounds;
  }

  /** Any cell is clear. */
  get clear(): boolean {
    return !isEmpty(this.#bounds);
  }

  /** How clear the clearest cell is. */
  get peak(): number {
    const { cols, values } = this;
    const bounds = this.#bounds;
    let peak = 0;
    for (let row = bounds.top; row < bounds.bottom; row++) {
      for (let col = bounds.left; col < bounds.right; col++) {
        peak = Math.max(peak, values[row * cols + col] ?? 0);
      }
    }
    return peak;
  }

  /** How clear the cell at `col`, `row` is; outside the grid, frosted. */
  at(col: number, row: number): number {
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return 0;
    return this.values[row * this.cols + col] ?? 0;
  }

  /**
   * One touch of a soft round cloth at `x`, `y` (CSS pixels): each cell under it clears by up to
   * `strength`, most at the centre and none at `radius`. Touches build up without passing clear.
   */
  dab(x: number, y: number, radius: number, strength: number): void {
    const { cell, cols, rows, values } = this;
    const left = Math.max(0, Math.floor((x - radius) / cell));
    const right = Math.min(cols - 1, Math.floor((x + radius) / cell));
    const top = Math.max(0, Math.floor((y - radius) / cell));
    const bottom = Math.min(rows - 1, Math.floor((y + radius) / cell));
    if (left > right || top > bottom || radius <= 0 || strength <= 0) return;
    const inverse = 1 / (radius * radius);
    for (let row = top; row <= bottom; row++) {
      const dy = (row + 0.5) * cell - y;
      for (let col = left; col <= right; col++) {
        const dx = (col + 0.5) * cell - x;
        const distance = (dx * dx + dy * dy) * inverse;
        if (distance >= 1) continue;
        const falloff = (1 - distance) * (1 - distance);
        const index = row * cols + col;
        values[index] = 1 - (1 - (values[index] ?? 0)) * (1 - strength * falloff);
      }
    }
    this.#bounds = union(this.#bounds, { left, top, right: right + 1, bottom: bottom + 1 });
  }

  /** The cloth drawn from one point to the next, touching down every `spacing` pixels on the way. */
  rub(
    from: { readonly x: number; readonly y: number },
    to: { readonly x: number; readonly y: number },
    radius: number,
    strength: number,
    spacing: number,
  ): void {
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / spacing));
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      this.dab(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, radius, strength);
    }
  }

  /** Lets the fog back: every cell keeps `factor` of its clearness. */
  fog(factor: number): void {
    if (!this.clear || factor >= 1) return;
    const { cols, values } = this;
    const bounds = this.#bounds;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (let row = bounds.top; row < bounds.bottom; row++) {
      for (let col = bounds.left; col < bounds.right; col++) {
        const index = row * cols + col;
        const value = (values[index] ?? 0) * factor;
        if (value < EPSILON) {
          values[index] = 0;
          continue;
        }
        values[index] = value;
        if (col < left) left = col;
        if (col >= right) right = col + 1;
        if (row < top) top = row;
        if (row >= bottom) bottom = row + 1;
      }
    }
    this.#bounds = right > left ? { left, top, right, bottom } : NONE;
  }

  /** Takes on whatever `other`, a grid of the same size, has clearer. */
  absorb(other: PolishGrid): void {
    if (!other.clear || other.cols !== this.cols || other.rows !== this.rows) return;
    const { cols, values } = this;
    const bounds = other.bounds;
    for (let row = bounds.top; row < bounds.bottom; row++) {
      for (let col = bounds.left; col < bounds.right; col++) {
        const index = row * cols + col;
        const theirs = other.values[index] ?? 0;
        if (theirs > (values[index] ?? 0)) values[index] = theirs;
      }
    }
    this.#bounds = union(this.#bounds, bounds);
  }

  /** Frosts every cell again. */
  reset(): void {
    this.values.fill(0);
    this.#bounds = NONE;
  }
}

/** A rectangle on the glass, in CSS pixels. */
export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

const smoothstep = (from: number, to: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

/** Random numbers from `seed`, the same run every time: a pane redrawn keeps its fog's shape. */
export const seeded = (seed: number): (() => number) => {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** How many puffs of breath fray the patch's edge. */
const PUFFS = 7;
/** How far past the oval through the question's corners the breath thins out to nothing. */
const OVAL_REACH = 1.3;
/** The most room the fog takes to thin out before a pane's edge, in CSS pixels. */
const EDGE_BAND = 96;

/**
 * How thick the fog lies over each of `grid`'s cells on a `width` by `height` pane: a breath's patch
 * over `question`, its edge frayed by `random`, thinning to nothing before the pane's own edges so the
 * pane meets the window around it as it always does, and before `floor`, where the message box sits
 * under the question, so the box's own glass stays clear. 1 is full fog, 0 clear glass.
 */
export const breath = (
  grid: PolishGrid,
  width: number,
  height: number,
  question: Rect,
  size: number,
  random: () => number,
  floor: number = height,
): Float32Array => {
  // The breath itself: an oval through the question's corners, full over its middle and its lines' ends.
  const centreX = (question.left + question.right) / 2;
  const centreY = (question.top + question.bottom) / 2;
  const ovalX = ((question.right - question.left) / 2) * Math.SQRT2;
  const ovalY = ((question.bottom - question.top) / 2) * Math.SQRT2;
  const reachX = ovalX * 0.7 + size * 0.6;
  const reachY = ovalY * 0.7 + size * 0.5;
  // The puffs around its edge.
  const puffs = Array.from({ length: PUFFS }, (_, puff) => {
    const angle = ((puff + random() * 0.6) / PUFFS) * Math.PI * 2;
    const out = 0.55 + random() * 0.35;
    const radius = Math.min(reachX, reachY) * (0.5 + random() * 0.4);
    return {
      x: centreX + Math.cos(angle) * reachX * out,
      y: centreY + Math.sin(angle) * reachY * out,
      rx: radius * (1 + random() * 0.6),
      ry: radius,
    };
  });
  const { cell, cols, rows } = grid;
  const fog = new Float32Array(cols * rows);
  // Only the cells the breath reaches, since this runs on every frame of a window's resize.
  let left = centreX - ovalX * OVAL_REACH;
  let right = centreX + ovalX * OVAL_REACH;
  let top = centreY - ovalY * OVAL_REACH;
  let bottom = centreY + ovalY * OVAL_REACH;
  for (const puff of puffs) {
    left = Math.min(left, puff.x - puff.rx);
    right = Math.max(right, puff.x + puff.rx);
    top = Math.min(top, puff.y - puff.ry);
    bottom = Math.max(bottom, puff.y + puff.ry);
  }
  const fromCol = Math.max(0, Math.floor(left / cell));
  const toCol = Math.min(cols, Math.ceil(right / cell));
  const fromRow = Math.max(0, Math.floor(top / cell));
  const foot = Math.min(height, floor);
  const toRow = Math.min(rows, Math.ceil(Math.min(bottom, foot) / cell));
  // Each edge thins the fog over the room the question leaves it, so a narrow pane's stays on the letters.
  const bandX = Math.min(EDGE_BAND, Math.max(12, Math.min(question.left, width - question.right) * 0.8));
  const bandTop = Math.min(EDGE_BAND, Math.max(12, question.top * 0.8));
  const bandFoot = Math.min(EDGE_BAND, Math.max(12, (foot - question.bottom) * 0.8));
  const edgesX = Array.from({ length: cols }, (_, col) => {
    const x = (col + 0.5) * cell;
    return smoothstep(0, bandX, Math.min(x, width - x));
  });
  for (let row = fromRow; row < toRow; row++) {
    const y = (row + 0.5) * cell;
    const edgeY = Math.min(smoothstep(0, bandTop, y), smoothstep(0, bandFoot, foot - y));
    if (edgeY === 0) continue;
    const ovalDy = ((y - centreY) / ovalY) ** 2;
    for (let col = fromCol; col < toCol; col++) {
      const edge = edgeY * (edgesX[col] ?? 0);
      if (edge === 0) continue;
      const x = (col + 0.5) * cell;
      // How much of the glass each part of the breath leaves clear, multiplied.
      const oval = ((x - centreX) / ovalX) ** 2 + ovalDy;
      let clear = oval >= OVAL_REACH ** 2 ? 1 : smoothstep(0.75, OVAL_REACH, Math.sqrt(oval));
      for (const puff of puffs) {
        const distance = ((x - puff.x) / puff.rx) ** 2 + ((y - puff.y) / puff.ry) ** 2;
        if (distance < 1) clear *= smoothstep(0, 1, Math.sqrt(distance));
      }
      fog[row * cols + col] = (1 - clear) * edge;
    }
  }
  return fog;
};

/** One line of the question as drawn: where its text starts, its middle, and where each character ends. */
export interface RevealLine {
  readonly left: number;
  readonly middle: number;
  /** From `left`, where each character ends, the last being the line's width. */
  readonly ends: ReadonlyArray<number>;
}

/** A stretch of one line for the cloth to wipe along, from `from` to `to` at height `y`. */
export interface RevealStroke {
  readonly from: number;
  readonly to: number;
  readonly y: number;
}

/**
 * Where typing from `start` characters to `end` wipes the question: typing the n-th character clears
 * the question's n-th, line after line, each line's wipe reaching `overhang` past its ends.
 */
export const revealStrokes = (
  lines: ReadonlyArray<RevealLine>,
  start: number,
  end: number,
  overhang: number,
): ReadonlyArray<RevealStroke> => {
  const strokes: Array<RevealStroke> = [];
  let offset = 0;
  for (const line of lines) {
    const count = line.ends.length;
    const from = Math.max(start, offset);
    const to = Math.min(end, offset + count);
    if (to > from) {
      const x = (chars: number, edge: "from" | "to") => {
        const into = chars - offset;
        if (edge === "from" && into <= 0) return line.left - overhang;
        if (edge === "to" && into >= count) return line.left + (line.ends[count - 1] ?? 0) + overhang;
        const whole = Math.floor(into);
        const before = whole === 0 ? 0 : (line.ends[whole - 1] ?? 0);
        const after = line.ends[whole] ?? before;
        return line.left + before + (after - before) * (into - whole);
      };
      strokes.push({ from: x(from, "from"), to: x(to, "to"), y: line.middle });
    }
    offset += count;
  }
  return strokes;
};

/** How many characters the question has to clear, over all its lines. */
export const revealLength = (lines: ReadonlyArray<RevealLine>): number =>
  lines.reduce((sum, line) => sum + line.ends.length, 0);
