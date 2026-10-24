/**
 * The light behind the welcome (features/onboarding): a beam of white light comes in from the left,
 * through Cerium's mark drawn as glass, and the facet in the mark's mouth splits it into five beams,
 * one for each harness: one thread, every agent. Each chapter poses the scene (where the mark is,
 * where the light comes from and where each beam lands) and the scene eases from one pose to the
 * next, so the welcome never cuts. The pointer steers the light a little, dust drifts through it, and
 * a pulse can run down the beam and split with it.
 *
 * Two canvases draw it. The light's glow is drawn on one a quarter the stage's size, which the page
 * stretches over it and so softens for next to nothing; the beams' bright cores, the dust and the glass
 * are drawn sharp on the other, over it.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Where one beam out of the facet lands, and how brightly; 0 leaves it dark. */
export interface BeamPose extends Point {
  readonly intensity: number;
}

/** A chapter's arrangement of the scene, in CSS pixels from the stage's corner. */
export interface PrismPose {
  /** The mark's centre, its size (as the mark's 48-unit drawing is scaled) and how much it shows. */
  readonly mark: { readonly x: number; readonly y: number; readonly size: number; readonly opacity: number };
  /** The light coming in: where from, where to (the facet, unless it runs on past the mark) and how bright. */
  readonly incoming: { readonly from: Point; readonly to?: Point; readonly intensity: number };
  /** The five beams the facet splits the light into, in the harnesses' order, top to bottom. */
  readonly beams: ReadonlyArray<BeamPose>;
  /** How much dust shows in the light, 0 to 1. */
  readonly dust: number;
}

/** The colours the scene draws in, read from the welcome's tokens. */
export interface Palette {
  readonly dark: boolean;
  readonly light: Rgb;
  readonly beams: ReadonlyArray<Rgb>;
  readonly glass: Rgb;
}

type Rgb = readonly [number, number, number];

/** A beam as drawn this frame: from the facet to where it lands. */
interface Ray {
  readonly from: Point;
  readonly to: Point;
  readonly intensity: number;
  readonly color: Rgb;
}

/** The scene as the springs have it this frame. */
interface Scene {
  readonly mark: { readonly x: number; readonly y: number; readonly size: number; readonly opacity: number };
  readonly from: Point;
  /** The light's own end, when it runs on past the mark rather than into the facet. */
  readonly to: Point | undefined;
  readonly incoming: number;
  readonly dust: number;
  readonly beams: ReadonlyArray<BeamPose>;
}

/** The mark's drawing, in its 48-unit square: the C's ring and the facet in its mouth, from the centre. */
const RING_RADIUS = 15;
const RING_WIDTH = 6;
const FACET_X = 12;
const FACET_HALF = 4.5;
/** The C opens towards the right, between these angles. */
const MOUTH = Math.PI / 4;

/** How far apart the beams leave the facet, in mark units. */
const EXIT_SPREAD = 1.1;
/** How wide a beam's glow is where it leaves the facet and where it lands, in CSS pixels. */
const BEAM_START_WIDTH = 4;
const BEAM_END_WIDTH = 64;
const INCOMING_WIDTH = 22;

/** How big the glow's canvas is against the stage, and how much it blurs there, in its own pixels. */
const GLOW_SCALE = 0.25;
const GLOW_BLUR = 2.5;

/** How much dust drifts through the stage. */
const MOTES = 240;

/** How stiff the scene's easing from pose to pose is, and how much it's damped (critically, here). */
const STIFFNESS = 38;
const DAMPING = 2 * Math.sqrt(STIFFNESS);
/** How long a pulse takes to run down the light and out along the beams. */
const PULSE_MS = 1_500;
/**
 * The first light, as the welcome opens: the glass fades in, then the light comes on, then the beams
 * reach out of the facet, each this many seconds after the glass starts.
 */
const LIGHT_AFTER = 0.35;
const BEAMS_AFTER = 0.75;
/** Where each part of a pose sits among its numbers (`poseNumbers`). */
const INCOMING_AT = 8;
const DUST_AT = 9;
const BEAMS_AT = 10;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** A colour channel's values, from any CSS colour. */
const channels = (color: string): Rgb => {
  const canvas = new OffscreenCanvas(1, 1);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return [255, 255, 255];
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r = 255, g = 255, b = 255] = context.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
};

/** White, for light glass's highlights. */
const SHINE: Rgb = [255, 255, 255];

const rgba = ([r, g, b]: Rgb, alpha: number) => `rgba(${r} ${g} ${b} / ${clamp01(alpha)})`;

/** Reads the scene's colours from the tokens on `element`. */
export const readPalette = (element: HTMLElement): Palette => {
  const probe = document.createElement("span");
  element.append(probe);
  const color = (token: string) => {
    probe.style.color = `var(${token})`;
    return channels(getComputedStyle(probe).color);
  };
  const palette = {
    dark: document.documentElement.dataset["theme"] !== "light",
    light: color("--welcome-light"),
    beams: [1, 2, 3, 4, 5].map((n) => color(`--welcome-beam-${n}`)),
    glass: color("--fg-primary"),
  };
  probe.remove();
  return palette;
};

/** A number eased towards its target like a spring, critically damped. */
class Spring {
  value: number;
  target: number;
  /** How long it holds before it starts towards its target, in seconds. */
  wait = 0;
  #velocity = 0;
  constructor(value: number) {
    this.value = value;
    this.target = value;
  }
  /** Moves on by `dt` seconds; whether it's still moving. */
  step(dt: number): boolean {
    if (this.wait > 0) {
      this.wait -= dt;
      return true;
    }
    const force = STIFFNESS * (this.target - this.value) - DAMPING * this.#velocity;
    this.#velocity += force * dt;
    this.value += this.#velocity * dt;
    if (Math.abs(this.target - this.value) < 0.01 && Math.abs(this.#velocity) < 0.01) {
      this.value = this.target;
      this.#velocity = 0;
      return false;
    }
    return true;
  }
  snap() {
    this.value = this.target;
    this.wait = 0;
    this.#velocity = 0;
  }
}

/** A pose's numbers, each on a spring, in a fixed order. */
const poseNumbers = (pose: PrismPose): Array<number> => {
  const to = pose.incoming.to ?? { x: Number.NaN, y: Number.NaN };
  return [
    pose.mark.x,
    pose.mark.y,
    pose.mark.size,
    pose.mark.opacity,
    pose.incoming.from.x,
    pose.incoming.from.y,
    to.x,
    to.y,
    pose.incoming.intensity,
    pose.dust,
    ...pose.beams.flatMap((beam) => [beam.x, beam.y, beam.intensity]),
  ];
};

/** `pose` before any light: the glass not yet showing, the light off, and the beams still in the facet. */
const darkened = (pose: PrismPose): PrismPose => {
  const unit = pose.mark.size / 48;
  const facet = { x: pose.mark.x + (FACET_X + FACET_HALF) * unit, y: pose.mark.y };
  return {
    mark: { ...pose.mark, size: pose.mark.size * 0.92, opacity: 0 },
    incoming: { ...pose.incoming, intensity: 0 },
    beams: pose.beams.map(() => ({ ...facet, intensity: 0 })),
    dust: 0,
  };
};

/** One mote of dust: where it drifts about, in the stage's fractions, and how it twinkles. */
interface Mote {
  readonly x: number;
  readonly y: number;
  readonly phase: number;
  readonly speed: number;
  readonly size: number;
}

export class Prism {
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  /** The light's glow, a quarter the stage's size. */
  readonly #glow: HTMLCanvasElement;
  readonly #glowContext: CanvasRenderingContext2D;
  readonly #reduceMotion: boolean;
  readonly #motes: ReadonlyArray<Mote>;
  #palette: Palette | undefined;
  #size = { width: 0, height: 0, scale: 1 };
  #springs: Array<Spring> | undefined;
  /** Where the pointer is, eased, from -1 to 1 across the stage each way. */
  #pointer = { x: new Spring(0), y: new Spring(0) };
  #pulseFrom: number | undefined;
  #frame = 0;
  #tickedAt = 0;
  #time = 0;
  #moving = true;
  #hidden = false;

  constructor(canvas: HTMLCanvasElement, glowCanvas: HTMLCanvasElement, reduceMotion: boolean) {
    const context = canvas.getContext("2d");
    const glow = glowCanvas.getContext("2d");
    if (context === null || glow === null) throw new Error("The welcome's light needs a 2D canvas");
    this.#canvas = canvas;
    this.#context = context;
    this.#glow = glowCanvas;
    this.#glowContext = glow;
    this.#reduceMotion = reduceMotion;
    let seed = 0x9e3779b9;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    this.#motes = Array.from({ length: MOTES }, () => ({
      x: random(),
      y: random(),
      phase: random() * Math.PI * 2,
      speed: 0.02 + random() * 0.05,
      size: 0.6 + random() * 1.3,
    }));
  }

  /** The stage is this big now. */
  resize(width: number, height: number, scale: number): void {
    this.#size = { width, height, scale };
    const pixels = (value: number) => Math.max(1, Math.round(value * scale));
    this.#canvas.width = pixels(width);
    this.#canvas.height = pixels(height);
    this.#glow.width = Math.max(1, Math.ceil(width * GLOW_SCALE));
    this.#glow.height = Math.max(1, Math.ceil(height * GLOW_SCALE));
    this.#wake();
  }

  /** The theme changed: the scene draws in its colours from now on. */
  recolor(palette: Palette): void {
    this.#palette = palette;
    this.#wake();
  }

  /** Eases the scene to `pose`; the first pose comes up out of the dark. */
  pose(pose: PrismPose): void {
    const numbers = poseNumbers(pose);
    if (this.#springs === undefined || this.#springs.length !== numbers.length) {
      this.#springs = poseNumbers(darkened(pose)).map((value) => new Spring(value));
      this.#springs.forEach((spring, index) => {
        spring.target = numbers[index]!;
        if (this.#reduceMotion) spring.snap();
        else if (index === INCOMING_AT) spring.wait = LIGHT_AFTER;
        else if (index >= BEAMS_AT || index === DUST_AT) spring.wait = BEAMS_AFTER;
      });
    } else {
      this.#springs.forEach((spring, index) => {
        const value = numbers[index]!;
        // A pose whose light runs to the facet has no point of its own: it follows the facet.
        if (Number.isNaN(value) || Number.isNaN(spring.value)) {
          spring.value = value;
          spring.target = value;
        } else spring.target = value;
        if (this.#reduceMotion) spring.snap();
      });
    }
    this.#wake();
  }

  /** The pointer is here, from -1 to 1 across the stage each way; the light leans after it. */
  point(x: number, y: number): void {
    if (this.#reduceMotion) return;
    this.#pointer.x.target = x;
    this.#pointer.y.target = y;
    this.#wake();
  }

  /** Runs a pulse of light down the beam and out along each lit beam. */
  pulse(): void {
    if (this.#reduceMotion) return;
    this.#pulseFrom = performance.now();
    this.#wake();
  }

  /** The page is hidden, or shown again: a hidden page draws nothing. */
  set hidden(hidden: boolean) {
    this.#hidden = hidden;
    if (!hidden) this.#wake();
  }

  dispose(): void {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
  }

  #wake() {
    this.#moving = true;
    if (this.#frame !== 0 || this.#hidden) return;
    this.#tickedAt = performance.now();
    this.#frame = requestAnimationFrame(this.#tick);
  }

  readonly #tick = (now: number) => {
    this.#frame = 0;
    const dt = Math.min(0.05, (now - this.#tickedAt) / 1000);
    this.#tickedAt = now;
    this.#time += dt;
    let moving = false;
    for (const spring of this.#springs ?? []) if (spring.step(dt)) moving = true;
    if (this.#pointer.x.step(dt)) moving = true;
    if (this.#pointer.y.step(dt)) moving = true;
    if (this.#pulseFrom !== undefined && now - this.#pulseFrom > PULSE_MS) this.#pulseFrom = undefined;
    this.#draw(now);
    // The dust and the shimmer keep the light alive; without motion it rests once the pose is reached.
    this.#moving = moving || this.#pulseFrom !== undefined || !this.#reduceMotion;
    if (this.#moving && !this.#hidden) this.#frame = requestAnimationFrame(this.#tick);
  };

  /** The pose as the springs have it now. */
  #current(): Scene {
    const values = (this.#springs ?? []).map((spring) => spring.value);
    const at = (index: number) => values[index] ?? 0;
    const lean = { x: this.#pointer.x.value, y: this.#pointer.y.value };
    const mark = {
      x: at(0) + lean.x * 6,
      y: at(1) + lean.y * 6,
      size: Math.max(1, at(2)),
      opacity: clamp01(at(3)),
    };
    const beams: Array<BeamPose> = [];
    for (let index = BEAMS_AT; index + 2 < values.length; index += 3) {
      beams.push({ x: at(index), y: at(index + 1) - lean.y * 14, intensity: clamp01(at(index + 2)) });
    }
    const to = Number.isNaN(at(6)) ? undefined : { x: at(6), y: at(7) };
    return {
      mark,
      // The light comes in from wherever the pointer leans, pivoting where it lands.
      from: { x: at(4) + lean.x * this.#size.width * 0.1, y: at(5) + lean.y * this.#size.height * 0.1 },
      to,
      incoming: clamp01(at(INCOMING_AT)),
      dust: clamp01(at(DUST_AT)),
      beams,
    };
  }

  #draw(now: number) {
    const palette = this.#palette;
    const context = this.#context;
    const { width, scale } = this.#size;
    const glow = this.#glowContext;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    glow.setTransform(1, 0, 0, 1, 0, 0);
    glow.clearRect(0, 0, this.#glow.width, this.#glow.height);
    if (palette === undefined || this.#springs === undefined || width === 0) return;
    const scene = this.#current();
    const unit = scene.mark.size / 48;
    const facetIn = { x: scene.mark.x + (FACET_X - FACET_HALF) * unit, y: scene.mark.y };
    const facetOut = { x: scene.mark.x + (FACET_X + FACET_HALF) * unit, y: scene.mark.y };
    const lightTo = scene.to ?? facetIn;
    // The light through the facet only, so a mark faded away splits nothing.
    const split = scene.to === undefined ? scene.mark.opacity : 0;
    const shimmer = this.#reduceMotion ? 1 : 0.92 + 0.08 * Math.sin(this.#time * 2.3);
    const pulse = this.#pulseFrom === undefined ? undefined : (now - this.#pulseFrom) / PULSE_MS;

    const beams = scene.beams.map((beam, index): Ray => {
      const offset = (index - (scene.beams.length - 1) / 2) * EXIT_SPREAD * unit;
      return {
        from: { x: facetOut.x, y: facetOut.y + offset },
        to: { x: beam.x, y: beam.y },
        intensity: beam.intensity * split * shimmer,
        color: palette.beams[index % palette.beams.length]!,
      };
    });

    // The glow: the light coming in and each beam, soft.
    glow.setTransform(GLOW_SCALE, 0, 0, GLOW_SCALE, 0, 0);
    glow.globalCompositeOperation = palette.dark ? "lighter" : "source-over";
    glow.filter = `blur(${GLOW_BLUR}px)`;
    // On light glass, colour shows by darkening it: the white light's haze would read as smoke there.
    const strength = palette.dark ? 1 : 0.85;
    if (scene.incoming > 0) {
      wedge(glow, scene.from, lightTo, INCOMING_WIDTH, INCOMING_WIDTH * 0.8, palette.light, [
        0.0,
        (palette.dark ? 0.22 : 0.06) * scene.incoming,
      ]);
    }
    for (const beam of beams) {
      if (beam.intensity <= 0.002) continue;
      wedge(glow, beam.from, beam.to, BEAM_START_WIDTH, BEAM_END_WIDTH, beam.color, [
        0.55 * beam.intensity * strength,
        0.05 * beam.intensity * strength,
      ]);
    }

    glow.filter = "none";

    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.globalCompositeOperation = palette.dark ? "lighter" : "source-over";

    // The cores: a hairline of light down the middle of each beam.
    if (scene.incoming > 0) {
      line(context, scene.from, lightTo, palette.light, 1.4, [
        0,
        (palette.dark ? 0.85 : 0.5) * scene.incoming * shimmer,
      ]);
    }
    for (const beam of beams) {
      if (beam.intensity <= 0.002) continue;
      line(context, beam.from, beam.to, beam.color, 1.2, [(palette.dark ? 0.95 : 0.85) * beam.intensity, 0]);
    }
    if (scene.dust > 0) this.#drawDust(context, scene, lightTo, beams, palette);
    if (pulse !== undefined && scene.incoming > 0.05) {
      this.#drawPulse(context, pulse, scene.incoming, scene.from, lightTo, beams, palette);
    }

    context.globalCompositeOperation = "source-over";
    if (scene.mark.opacity > 0.002) {
      drawMark(
        context,
        scene.mark,
        unit,
        palette,
        scene.incoming * split,
        lightTo === facetIn ? scene.from : undefined,
      );
    }
  }

  /** Dust drifting about the stage, seen only where light falls on it: a glint, and a little halo. */
  #drawDust(
    context: CanvasRenderingContext2D,
    scene: Scene,
    lightTo: Point,
    beams: ReadonlyArray<Ray>,
    palette: Palette,
  ) {
    const { width, height } = this.#size;
    const time = this.#reduceMotion ? 0 : this.#time;
    for (const mote of this.#motes) {
      const across = mote.x + Math.sin(time * mote.speed + mote.phase) * 0.04 + time * mote.speed * 0.08;
      const x = (((across % 1) + 1) % 1) * width;
      const y = (mote.y + Math.cos(time * mote.speed * 0.8 + mote.phase) * 0.05) * height;
      const point = { x, y };
      let lit = litBy(point, scene.from, lightTo, INCOMING_WIDTH * 1.6) * scene.incoming;
      let color = palette.light;
      for (const beam of beams) {
        const amount = litBy(point, beam.from, beam.to, BEAM_END_WIDTH * 0.9) * beam.intensity;
        if (amount > lit) {
          lit = amount;
          color = beam.color;
        }
      }
      const twinkle = 0.55 + 0.45 * Math.sin(time * 3 + mote.phase * 5);
      const alpha = lit * scene.dust * twinkle * (palette.dark ? 1 : 0.7);
      if (alpha < 0.03) continue;
      const halo = mote.size * 3.2;
      const glow = context.createRadialGradient(x, y, 0, x, y, halo);
      glow.addColorStop(0, rgba(color, alpha * 0.55));
      glow.addColorStop(1, rgba(color, 0));
      context.fillStyle = glow;
      context.fillRect(x - halo, y - halo, halo * 2, halo * 2);
      context.fillStyle = rgba(palette.dark ? SHINE : color, alpha);
      context.beginPath();
      context.arc(x, y, mote.size * 0.55, 0, Math.PI * 2);
      context.fill();
    }
  }

  /** A pulse: down the light coming in for its first half, then out along each lit beam. */
  #drawPulse(
    context: CanvasRenderingContext2D,
    t: number,
    incoming: number,
    from: Point,
    to: Point,
    beams: ReadonlyArray<Ray>,
    palette: Palette,
  ) {
    const blob = (at: Point, color: Rgb, alpha: number, radius: number) => {
      const gradient = context.createRadialGradient(at.x, at.y, 0, at.x, at.y, radius);
      gradient.addColorStop(0, rgba(color, alpha));
      gradient.addColorStop(1, rgba(color, 0));
      context.fillStyle = gradient;
      context.fillRect(at.x - radius, at.y - radius, radius * 2, radius * 2);
    };
    const fade = Math.sin(Math.PI * t);
    if (t < 0.5) {
      const along = easeInOut(t / 0.5);
      blob(lerpPoint(from, to, along), palette.light, 0.9 * fade * incoming, 26);
    } else {
      const along = easeOut((t - 0.5) / 0.5);
      for (const beam of beams) {
        if (beam.intensity <= 0.05) continue;
        blob(lerpPoint(beam.from, beam.to, along), beam.color, 0.9 * fade * beam.intensity, 30);
      }
    }
  }
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
const lerpPoint = (a: Point, b: Point, t: number): Point => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

/** How much light a beam from `a` to `b`, `width` wide, throws on `point`: 1 on its line, 0 off it. */
const litBy = (point: Point, a: Point, b: Point, width: number): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  if (length === 0) return 0;
  const t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / length;
  if (t < 0 || t > 1) return 0;
  const distance = Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
  return clamp01(1 - distance / (width * (0.3 + 0.7 * t)));
};

type Context2D = CanvasRenderingContext2D;

/** A beam's glow: a band from `a` to `b` widening as it goes, fading from one alpha to the other. */
const wedge = (
  context: Context2D,
  a: Point,
  b: Point,
  startWidth: number,
  endWidth: number,
  color: Rgb,
  [startAlpha, endAlpha]: readonly [number, number],
) => {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length < 1) return;
  const nx = -(b.y - a.y) / length;
  const ny = (b.x - a.x) / length;
  const gradient = context.createLinearGradient(a.x, a.y, b.x, b.y);
  gradient.addColorStop(0, rgba(color, startAlpha));
  gradient.addColorStop(0.35, rgba(color, (startAlpha * 2 + endAlpha) / 3));
  gradient.addColorStop(1, rgba(color, endAlpha));
  context.fillStyle = gradient;
  context.beginPath();
  context.moveTo(a.x + (nx * startWidth) / 2, a.y + (ny * startWidth) / 2);
  context.lineTo(b.x + (nx * endWidth) / 2, b.y + (ny * endWidth) / 2);
  context.lineTo(b.x - (nx * endWidth) / 2, b.y - (ny * endWidth) / 2);
  context.lineTo(a.x - (nx * startWidth) / 2, a.y - (ny * startWidth) / 2);
  context.closePath();
  context.fill();
};

/** A beam's core: a hairline fading from one alpha to the other. */
const line = (
  context: Context2D,
  a: Point,
  b: Point,
  color: Rgb,
  width: number,
  [startAlpha, endAlpha]: readonly [number, number],
) => {
  const gradient = context.createLinearGradient(a.x, a.y, b.x, b.y);
  gradient.addColorStop(0, rgba(color, startAlpha));
  gradient.addColorStop(1, rgba(color, endAlpha));
  context.strokeStyle = gradient;
  context.lineWidth = width;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(a.x, a.y);
  context.lineTo(b.x, b.y);
  context.stroke();
};

/**
 * The mark as glass: the C's ring, faintly filled and rimmed, catching light where the beam crosses
 * it, and the facet cut in four, bright where the light splits.
 */
const drawMark = (
  context: CanvasRenderingContext2D,
  mark: { x: number; y: number; size: number; opacity: number },
  unit: number,
  palette: Palette,
  lit: number,
  lightFrom: Point | undefined,
) => {
  const { x, y, opacity } = mark;
  const glass = palette.glass;
  const outer = (RING_RADIUS + RING_WIDTH / 2) * unit;
  const inner = (RING_RADIUS - RING_WIDTH / 2) * unit;
  const cap = (RING_WIDTH / 2) * unit;
  // The ring's outline: round caps at both ends of the C.
  const ring = new Path2D();
  ring.arc(x, y, outer, -MOUTH, MOUTH, true);
  const endCap = { x: x + Math.cos(MOUTH) * RING_RADIUS * unit, y: y + Math.sin(MOUTH) * RING_RADIUS * unit };
  ring.arc(endCap.x, endCap.y, cap, MOUTH, MOUTH - Math.PI, true);
  ring.arc(x, y, inner, MOUTH, -MOUTH, false);
  const startCap = {
    x: x + Math.cos(-MOUTH) * RING_RADIUS * unit,
    y: y + Math.sin(-MOUTH) * RING_RADIUS * unit,
  };
  ring.arc(startCap.x, startCap.y, cap, -MOUTH + Math.PI, -MOUTH, true);
  ring.closePath();

  // Dark glass is lit by the theme's own light; light glass is clear, so it shows white where it's thick.
  const fill = palette.dark ? glass : SHINE;
  const [bodyFrom, bodyMid, bodyTo] = palette.dark ? [0.16, 0.04, 0.1] : [0.75, 0.3, 0.55];
  const body = context.createLinearGradient(x - outer, y - outer, x + outer, y + outer);
  body.addColorStop(0, rgba(fill, bodyFrom * opacity));
  body.addColorStop(0.5, rgba(fill, bodyMid * opacity));
  body.addColorStop(1, rgba(fill, bodyTo * opacity));
  context.fillStyle = body;
  context.fill(ring);
  const [rimFrom, rimMid, rimTo] = palette.dark ? [0.55, 0.12, 0.32] : [0.28, 0.1, 0.22];
  const rim = context.createLinearGradient(x - outer, y - outer, x + outer * 0.6, y + outer);
  rim.addColorStop(0, rgba(glass, rimFrom * opacity));
  rim.addColorStop(0.45, rgba(glass, rimMid * opacity));
  rim.addColorStop(1, rgba(glass, rimTo * opacity));
  context.strokeStyle = rim;
  context.lineWidth = 1;
  context.stroke(ring);
  const glint = palette.dark ? palette.light : SHINE;

  // Where the light crosses the ring, the glass catches it.
  if (lightFrom !== undefined && lit > 0) {
    context.globalCompositeOperation = palette.dark ? "lighter" : "source-over";
    const towards = Math.atan2(lightFrom.y - y, lightFrom.x - x);
    const at = {
      x: x + Math.cos(towards) * RING_RADIUS * unit,
      y: y + Math.sin(towards) * RING_RADIUS * unit,
    };
    const radius = RING_WIDTH * unit * 0.9;
    const caught = context.createRadialGradient(at.x, at.y, 0, at.x, at.y, radius);
    caught.addColorStop(0, rgba(glint, (palette.dark ? 0.32 : 0.9) * lit * opacity));
    caught.addColorStop(1, rgba(glint, 0));
    context.fillStyle = caught;
    context.fillRect(at.x - radius, at.y - radius, radius * 2, radius * 2);
    context.globalCompositeOperation = "source-over";
  }

  // The facet, cut in four: each face catches a different share of the light.
  const facet = { x: x + FACET_X * unit, y };
  const half = FACET_HALF * unit;
  const corners = [
    { x: facet.x - half, y: facet.y },
    { x: facet.x, y: facet.y - half },
    { x: facet.x + half, y: facet.y },
    { x: facet.x, y: facet.y + half },
  ];
  const faces = palette.dark ? [0.34, 0.16, 0.08, 0.22] : [0.95, 0.72, 0.5, 0.85];
  const shades = palette.dark ? [0, 0, 0, 0] : [0.03, 0.08, 0.16, 0.05];
  corners.forEach((corner, index) => {
    const next = corners[(index + 1) % corners.length]!;
    const face = new Path2D();
    face.moveTo(facet.x, facet.y);
    face.lineTo(corner.x, corner.y);
    face.lineTo(next.x, next.y);
    face.closePath();
    context.fillStyle = rgba(fill, Math.min(1, faces[index]! + 0.3 * lit) * opacity);
    context.fill(face);
    if (shades[index]! > 0) {
      context.fillStyle = rgba(glass, shades[index]! * opacity);
      context.fill(face);
    }
  });
  context.strokeStyle = rgba(glass, (palette.dark ? 0.6 : 0.4) * opacity);
  context.lineWidth = 1;
  context.beginPath();
  corners.forEach((corner, index) =>
    index === 0 ? context.moveTo(corner.x, corner.y) : context.lineTo(corner.x, corner.y),
  );
  context.closePath();
  context.stroke();

  // The light splitting in the facet.
  if (lit > 0) {
    context.globalCompositeOperation = palette.dark ? "lighter" : "source-over";
    const radius = half * 3.2;
    const flare = context.createRadialGradient(facet.x, facet.y, 0, facet.x, facet.y, radius);
    flare.addColorStop(0, rgba(glint, (palette.dark ? 0.7 : 0.95) * lit * opacity));
    flare.addColorStop(0.3, rgba(glint, (palette.dark ? 0.18 : 0.5) * lit * opacity));
    flare.addColorStop(1, rgba(glint, 0));
    context.fillStyle = flare;
    context.fillRect(facet.x - radius, facet.y - radius, radius * 2, radius * 2);
    context.globalCompositeOperation = "source-over";
  }
};
