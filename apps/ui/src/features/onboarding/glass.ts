/**
 * Cerium's mark in glass, in three dimensions, for the welcome (features/onboarding): a fragment
 * shader ray-marches the mark as solid glass, the C a capped torus and the facet in its mouth an
 * octahedron, and lights it as a studio would a glass object. Each ray that meets the glass is bent in,
 * runs through it (bouncing inside up to twice if it must), and is bent out again a little differently
 * for each colour, which splits the light at its edges as a prism does. The glass takes the theme's
 * accent as its colour, by absorbing the rest as light passes through it.
 *
 * The mark turns slowly and leans after the pointer, and the facet spins in the C's mouth. Without
 * motion it's drawn once, still.
 */

const VERTEX = `#version 300 es
void main() {
  // One triangle over the whole canvas.
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform mat3 uRotation;
uniform float uSpin;
uniform float uScale;
uniform vec3 uTint;
uniform vec3 uBackdrop;
uniform float uDark;

out vec4 fragColor;

// The camera, far enough back that the mark barely bends in perspective.
const vec3 EYE = vec3(0.0, 0.0, 6.5);
const float LENS = 0.235;
// How far light bends in the glass, from red to violet: more than real glass, so the split shows.
const vec3 IOR = vec3(1.43, 1.47, 1.515);
// The spectrum the light leaving the glass is split into, red to violet, as each part adds to red, green
// and blue; each channel's parts add up to one, so white light stays white. Spread over six, a face
// that splits the light shades from one colour to the next rather than into flat red and blue.
const vec3 SPECTRUM[6] = vec3[6](
  vec3(1.0, 0.0, 0.0) / vec3(2.5, 2.6, 2.6),
  vec3(0.8, 0.5, 0.0) / vec3(2.5, 2.6, 2.6),
  vec3(0.3, 1.0, 0.1) / vec3(2.5, 2.6, 2.6),
  vec3(0.0, 0.8, 0.6) / vec3(2.5, 2.6, 2.6),
  vec3(0.0, 0.3, 1.0) / vec3(2.5, 2.6, 2.6),
  vec3(0.4, 0.0, 0.9) / vec3(2.5, 2.6, 2.6)
);
const float BOUND = 1.32;

mat2 turn(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, s, -s, c);
}

// iq's capped torus: an arc of a torus, round at both ends.
float cappedTorus(vec3 p, vec2 sc, float ra, float rb) {
  p.x = abs(p.x);
  float k = (sc.y * p.x > sc.x * p.y) ? dot(p.xy, sc) : length(p.xy);
  return sqrt(dot(p, p) + ra * ra - 2.0 * ra * k) - rb;
}

// iq's exact octahedron.
float octahedron(vec3 p, float s) {
  p = abs(p);
  float m = p.x + p.y + p.z - s;
  vec3 q;
  if (3.0 * p.x < m) q = p.xyz;
  else if (3.0 * p.y < m) q = p.yzx;
  else if (3.0 * p.z < m) q = p.zxy;
  else return m * 0.57735027;
  float k = clamp(0.5 * (q.z - q.y + s), 0.0, s);
  return length(vec3(q.x, q.y - s + k, q.z - k));
}

// The mark, in the 48-unit drawing's proportions with its ring's radius as 1: the C opens to the
// right, a quarter of a turn wide, and the facet sits in its mouth.
float mark(vec3 p) {
  p = uRotation * p / uScale;
  p.x += 0.05;
  float ring = cappedTorus(vec3(p.y, -p.x, p.z), vec2(0.70710678, -0.70710678), 1.0, 0.2);
  vec3 f = p - vec3(0.8, 0.0, 0.0);
  f.xz = turn(uSpin) * f.xz;
  // Its edges a touch rounded, so they catch the light as a cut stone's do.
  float facet = octahedron(f, 0.29) - 0.012;
  return min(ring, facet) * uScale;
}

vec3 normalAt(vec3 p) {
  const vec2 e = vec2(1.0, -1.0) * 0.0009;
  return normalize(
    e.xyy * mark(p + e.xyy) + e.yyx * mark(p + e.yyx) + e.yxy * mark(p + e.yxy) + e.xxx * mark(p + e.xxx)
  );
}

// A softbox: a soft-edged rectangle of the sky, \`width\` and \`height\` from its middle, in radians.
float softbox(float around, float rise, vec2 at, vec2 size, float soft) {
  float across = abs(atan(sin(around - at.x), cos(around - at.x)));
  vec2 off = vec2(across, abs(rise - at.y)) - size;
  return 1.0 - smoothstep(-soft, soft, max(off.x, off.y));
}

// The studio the glass sits in, as a photographer would light glass: the window's own colour all round, a wide softbox straight behind and a tall strip either side of it, which the glass
// bends into bright lines, a softbox overhead, and two by the camera whose reflections gloss its front.
vec3 studio(vec3 d) {
  float rise = asin(clamp(d.y, -1.0, 1.0));
  float around = atan(d.x, -d.z);
  vec3 light = uBackdrop * (0.6 + 0.8 * smoothstep(-0.9, 0.9, d.y));
  // Light glass needs dark to show against: a darker floor, and a black card either side, as a
  // photographer flags glass on white.
  float flags = softbox(around, rise, vec2(-1.55, 0.05), vec2(0.16, 0.75), 0.12)
              + softbox(around, rise, vec2(1.7, 0.1), vec2(0.1, 0.6), 0.1)
              + softbox(around, rise, vec2(3.14159, -0.1), vec2(0.5, 0.12), 0.12);
  light *= mix(1.0, (1.0 - 0.82 * clamp(flags, 0.0, 1.0)) * (0.5 + 0.5 * smoothstep(-0.45, 0.25, d.y)), 1.0 - uDark);
  float behind = softbox(around, rise, vec2(0.0, 0.16), vec2(0.42, 0.07), 0.1) * 5.0;
  float key = softbox(around, rise, vec2(-0.72, 0.2), vec2(0.06, 0.62), 0.05) * 9.0;
  float rim = softbox(around, rise, vec2(0.86, -0.05), vec2(0.035, 0.5), 0.04) * 7.0;
  float top = smoothstep(0.62, 0.95, rise) * 2.4;
  float glossLeft = softbox(around, rise, vec2(2.55, 0.42), vec2(0.24, 0.2), 0.08) * 16.0;
  float glossRight = softbox(around, rise, vec2(-2.42, 0.1), vec2(0.08, 0.34), 0.05) * 11.0;
  return light + vec3(behind + key + rim + top + glossLeft + glossRight);
}

// How far a ray inside the glass runs before it reaches the surface.
float throughGlass(vec3 from, vec3 dir) {
  float t = 0.0;
  for (int i = 0; i < 56; i++) {
    float d = -mark(from + dir * t);
    if (d < 0.0008) break;
    t += max(d, 0.003);
    if (t > 3.5) break;
  }
  return t;
}

vec3 glass(vec3 p, vec3 rd) {
  vec3 n = normalAt(p);
  float facing = clamp(dot(-rd, n), 0.0, 1.0);
  float fresnel = 0.04 + 0.96 * pow(1.0 - facing, 5.0);
  vec3 reflected = studio(reflect(rd, n));

  // In, through, and out again, turned back inside up to twice where it meets the far side too steeply.
  vec3 dir = refract(rd, n, 1.0 / IOR.g);
  vec3 at = p - n * 0.004;
  float depth = 0.0;
  vec3 out_ = vec3(0.0);
  vec3 back = vec3(0.0);
  for (int bounce = 0; bounce < 3; bounce++) {
    float run = throughGlass(at, dir);
    depth += run;
    at += dir * run;
    back = -normalAt(at);
    out_ = refract(dir, back, IOR.g);
    if (dot(out_, out_) > 0.0001 || bounce == 2) break;
    dir = reflect(dir, back);
    at += back * 0.004;
  }
  vec3 split = vec3(0.0);
  for (int part = 0; part < 6; part++) {
    vec3 leaving = refract(dir, back, mix(IOR.r, IOR.b, float(part) / 5.0));
    if (dot(leaving, leaving) < 0.0001) leaving = reflect(dir, back);
    split += studio(leaving) * SPECTRUM[part];
  }
  // Coloured glass keeps its own colour and takes the rest, more of it the deeper the light goes.
  vec3 absorb = (1.0 - uTint) * 1.9 + 0.04;
  vec3 through = split * exp(-absorb * depth);
  // In the dark, a coloured glass still shows its colour, as if lit a little from within; clear glass
  // stays clear.
  float chroma = max(uTint.r, max(uTint.g, uTint.b)) - min(uTint.r, min(uTint.g, uTint.b));
  through += uTint * chroma * 0.18 * depth * uDark;
  return mix(through, reflected, fresnel);
}

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - uResolution) / uResolution.y;
  vec3 rd = normalize(vec3(uv * LENS, -1.0));
  // Rays that miss the ball the mark turns in are only the window.
  float b = dot(EYE, rd);
  float c = dot(EYE, EYE) - BOUND * BOUND * uScale * uScale;
  float h = b * b - c;
  if (h < 0.0) {
    fragColor = vec4(0.0);
    return;
  }
  float t = -b - sqrt(h);
  float far = -b + sqrt(h);
  float nearest = 1e9;
  float nearestAt = t;
  bool hit = false;
  for (int i = 0; i < 90; i++) {
    float d = mark(EYE + rd * t);
    if (d < nearest) {
      nearest = d;
      nearestAt = t;
    }
    if (d < 0.0006) {
      hit = true;
      break;
    }
    t += d;
    if (t > far) break;
  }
  // A ray that only grazes the glass covers some of its pixel: the edge stays smooth.
  float pixel = 2.0 * LENS * nearestAt / uResolution.y;
  float cover = hit ? 1.0 : 1.0 - smoothstep(0.0, pixel * 1.25, nearest);
  if (cover <= 0.0) {
    fragColor = vec4(0.0);
    return;
  }
  vec3 color = glass(EYE + rd * (hit ? t : nearestAt), rd);
  color = 1.0 - exp(-color * 1.15);
  color = pow(color, vec3(1.0 / 2.2));
  fragColor = vec4(color * cover, cover);
}`;

/** The colours the glass is drawn in, as linear RGB. */
export interface GlassColors {
  /** The glass's own colour: the theme's accent. */
  readonly tint: readonly [number, number, number];
  /** What surrounds it: the window's colour. */
  readonly backdrop: readonly [number, number, number];
  readonly dark: boolean;
}

/** How long the mark takes to come out of the dark when it first shows, in seconds. */
const ARRIVE_S = 1.8;
/**
 * A GPU that can't keep up draws the glass at fewer pixels, the browser stretching them over the
 * canvas: past this long a frame on average, over this many frames, down to this share of them.
 */
const SLOW_FRAME_MS = 22;
const FRAMES_MEASURED = 30;
const LOWEST_QUALITY = 0.5;

const compile = (gl: WebGL2RenderingContext, type: number, source: string) => {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error("Couldn't create a shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) || "The glass shader didn't compile");
  }
  return shader;
};

/** The turn the shader gives every point it looks the mark up at: a yaw and a pitch, column by column. */
const rotation = (yaw: number, pitch: number): Float32Array => {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return new Float32Array([cy, sy * sp, -sy * cp, 0, cp, sp, sy, -cy * sp, cy * cp]);
};

export class GlassRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #gl: WebGL2RenderingContext;
  readonly #uniforms: Record<string, WebGLUniformLocation | null>;
  readonly #still: boolean;
  #colors: GlassColors = { tint: [0.9, 0.9, 0.9], backdrop: [0.01, 0.01, 0.01], dark: true };
  /** Where the pointer leans the mark, and where it has eased to. */
  #lean = { x: 0, y: 0 };
  #leaned = { x: 0, y: 0 };
  #frame = 0;
  #startedAt: number | undefined;
  #lastAt = 0;
  #running = false;
  #size = { width: 1, height: 1, scale: 1 };
  /** The share of the canvas's pixels drawn, lowered while frames run slow. */
  #quality = 1;
  #measured = { frames: 0, ms: 0 };

  /** Throws where the browser has no WebGL2: the caller shows the flat mark instead. */
  constructor(canvas: HTMLCanvasElement, still: boolean) {
    const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false });
    if (gl === null) throw new Error("No WebGL2");
    this.#canvas = canvas;
    this.#gl = gl;
    this.#still = still;
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "The glass shader didn't link");
    }
    gl.useProgram(program);
    gl.bindVertexArray(gl.createVertexArray());
    this.#uniforms = Object.fromEntries(
      ["uResolution", "uRotation", "uSpin", "uScale", "uTint", "uBackdrop", "uDark"].map((name) => [
        name,
        gl.getUniformLocation(program, name),
      ]),
    );
  }

  /** The canvas shows this many CSS pixels, at this many device pixels each. */
  resize(width: number, height: number, scale: number): void {
    this.#size = { width, height, scale };
    const pixels = scale * this.#quality;
    this.#canvas.width = Math.max(1, Math.round(width * pixels));
    this.#canvas.height = Math.max(1, Math.round(height * pixels));
    this.#gl.viewport(0, 0, this.#canvas.width, this.#canvas.height);
    this.#draw(performance.now());
  }

  recolor(colors: GlassColors): void {
    this.#colors = colors;
    this.#draw(performance.now());
  }

  /** The pointer is here, from -1 to 1 each way about the mark; it leans after it. */
  point(x: number, y: number): void {
    this.#lean = { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
  }

  /** Turns while it's in view; stops drawing while it isn't. */
  run(running: boolean): void {
    if (running === this.#running) return;
    this.#running = running;
    if (running && !this.#still) {
      this.#lastAt = performance.now();
      this.#frame = requestAnimationFrame(this.#tick);
    } else {
      cancelAnimationFrame(this.#frame);
      this.#frame = 0;
      if (running) this.#draw(performance.now());
    }
  }

  /** Stops drawing. The context stays with its canvas, which a remount may draw on again. */
  dispose(): void {
    cancelAnimationFrame(this.#frame);
    this.#running = false;
  }

  readonly #tick = (now: number) => {
    this.#measure(now - this.#lastAt);
    this.#draw(now);
    if (this.#running) this.#frame = requestAnimationFrame(this.#tick);
  };

  /** Draws at fewer pixels while frames take too long. */
  #measure(ms: number) {
    if (this.#quality <= LOWEST_QUALITY) return;
    this.#measured = { frames: this.#measured.frames + 1, ms: this.#measured.ms + ms };
    if (this.#measured.frames < FRAMES_MEASURED) return;
    const slow = this.#measured.ms / this.#measured.frames > SLOW_FRAME_MS;
    this.#measured = { frames: 0, ms: 0 };
    if (!slow) return;
    this.#quality = Math.max(LOWEST_QUALITY, this.#quality * 0.8);
    const { width, height, scale } = this.#size;
    this.resize(width, height, scale);
  }

  #draw(now: number) {
    const gl = this.#gl;
    if (gl.isContextLost()) return;
    this.#startedAt ??= now;
    const dt = Math.min(0.05, (now - this.#lastAt) / 1000);
    this.#lastAt = now;
    const time = this.#still ? 0 : (now - this.#startedAt) / 1000;
    // It arrives turning in from the side, settling as it comes into focus.
    const arrival = this.#still ? 1 : Math.min(1, time / ARRIVE_S);
    const settle = 1 - (1 - arrival) ** 3;
    const ease = 1 - Math.exp(-dt * 4);
    this.#leaned.x += (this.#lean.x - this.#leaned.x) * ease;
    this.#leaned.y += (this.#lean.y - this.#leaned.y) * ease;
    const yaw = (1 - settle) * -1.1 + Math.sin(time * 0.32) * 0.32 + this.#leaned.x * 0.38;
    const pitch = Math.sin(time * 0.23) * 0.07 + this.#leaned.y * 0.22;

    const { tint, backdrop, dark } = this.#colors;
    const u = this.#uniforms;
    gl.uniform2f(u["uResolution"]!, this.#canvas.width, this.#canvas.height);
    gl.uniformMatrix3fv(u["uRotation"]!, false, rotation(yaw, pitch));
    gl.uniform1f(u["uSpin"]!, this.#still ? 0.4 : time * 0.45 + 0.4);
    gl.uniform1f(u["uScale"]!, 0.86 + 0.14 * settle);
    gl.uniform3f(u["uTint"]!, ...tint);
    gl.uniform3f(u["uBackdrop"]!, ...backdrop);
    gl.uniform1f(u["uDark"]!, dark ? 1 : 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
