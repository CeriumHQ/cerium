// The light behind the hero: one white beam meets a prism and leaves as a spectrum, rippling a little
// as if through imperfect glass. It is the page's one bold element and the backdrop the app's glass
// window blurs, so it renders at a fraction of the screen's pixels (it is soft anyway), only while it
// is on screen, and as a single still frame when the reader asks for reduced motion.

const vertexSource = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }`;

const fragmentSource = `#version 300 es
precision highp float;

uniform vec2 resolution;
uniform float time;
// Where the beam meets the prism, in canvas pixels from the top left.
uniform vec2 prism;
// How far the reader has turned the prism, in radians.
uniform float turn;
// 0 while the hero is in view, rising to 1 as it scrolls away: the fan opens wider.
uniform float open;
// The light switching on as the page opens: how far the beam has come (0 to 1), then how far the
// spectrum has opened once it reaches the prism (0 to 1).
uniform float arrive;
uniform float lit;

out vec4 color;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    value += amplitude * noise(p);
    p *= 2.03;
    amplitude *= 0.5;
  }
  return value;
}

// The visible spectrum from red (0) to violet (1), as it falls from a prism: bright yellow and cyan
// between the primaries, never a hard band.
vec3 spectrum(float x) {
  const vec3 stops[7] = vec3[7](
    vec3(1.0, 0.12, 0.10),
    vec3(1.0, 0.42, 0.06),
    vec3(1.0, 0.86, 0.22),
    vec3(0.30, 1.0, 0.42),
    vec3(0.12, 0.82, 1.0),
    vec3(0.22, 0.36, 1.0),
    vec3(0.58, 0.22, 1.0)
  );
  float f = clamp(x, 0.0, 1.0) * 6.0;
  int i = int(min(floor(f), 5.0));
  return mix(stops[i], stops[i + 1], smoothstep(0.0, 1.0, f - float(i)));
}

void main() {
  vec2 pixel = vec2(gl_FragCoord.x, resolution.y - gl_FragCoord.y);
  float unit = resolution.y;
  vec2 v = (pixel - prism) / unit;

  // The beam arrives from the upper left.
  vec2 incoming = normalize(vec2(1.0, 0.58));
  float along = dot(v, -incoming);
  float across = abs(v.x * incoming.y - v.y * incoming.x);
  float beam = 0.0;
  if (along > 0.0) {
    float width = 0.0022 + along * 0.006;
    // A bright core in a wide haze: light seen through dust, not a laser.
    beam = exp(-pow(across / width, 2.0)) * 0.55
      + exp(-pow(across / (width * 5.0), 2.0)) * 0.12
      + exp(-pow(across / (width * 22.0), 2.0)) * 0.05;
    beam *= smoothstep(1.8, 0.1, along) * (0.8 + 0.4 * fbm(vec2(along * 6.0 - time * 0.3, across * 40.0)));
    float head = (1.0 - arrive) * 1.8;
    beam *= smoothstep(head - 0.02, head + 0.08, along);
  }

  // The fan leaves bent further down, red least and violet most.
  float r = length(v);
  float angle = atan(v.y, v.x);
  float centre = atan(incoming.y, incoming.x) + 0.5 + turn;
  float spread = 1.05 + open * 0.3;
  vec3 fan = vec3(0.0);
  const int BANDS = 18;
  for (int i = 0; i < BANDS; i++) {
    float x = float(i) / float(BANDS - 1);
    float d = angle - (centre + spread * (x - 0.5));
    float sigma = spread / float(BANDS) * 1.6;
    fan += spectrum(x) * exp(-d * d / (sigma * sigma));
  }
  fan /= float(BANDS) * 0.12;

  // The glass's top surface reflects a little of the beam back up, already parting into colours.
  vec3 glint = vec3(0.0);
  if (v.y < 0.0) {
    float glintCentre = atan(-incoming.y, incoming.x) - 0.1 + turn * 0.5;
    float glintSpread = 0.34;
    const int GLINTS = 10;
    for (int i = 0; i < GLINTS; i++) {
      float x = float(i) / float(GLINTS - 1);
      float d = angle - (glintCentre + glintSpread * (x - 0.5));
      float sigma = glintSpread / float(GLINTS) * 1.9;
      glint += spectrum(x) * exp(-d * d / (sigma * sigma));
    }
    glint /= float(GLINTS) * 0.85;
  }

  // Streaks travelling out along the rays, and a slow unevenness across the whole field.
  float ripple = fbm(vec2(angle * 36.0, r * 3.5 - time * 0.2));
  float drift = fbm(v * 1.4 + vec2(time * 0.025, -time * 0.018));
  float falloff = smoothstep(0.0, 0.04, r) * exp(-r * 1.1);
  fan *= falloff * (0.35 + 1.1 * ripple) * (0.5 + 1.0 * drift);
  glint *= smoothstep(0.0, 0.03, r) * exp(-r * 2.6) * (0.3 + 1.0 * ripple);
  fan += glint;
  fan *= lit;

  // The prism flares as the beam first strikes it, then settles.
  float flare = 1.0 + 1.6 * lit * (1.0 - lit) * 4.0;
  float glow = (exp(-r * r / 0.0004) * 1.2 + exp(-r * r / 0.012) * 0.22) * smoothstep(0.0, 0.15, lit) * flare;
  vec3 light = fan + vec3(beam) + vec3(glow) * vec3(1.0, 0.98, 0.95);
  light += vec3(0.010, 0.011, 0.015) * drift;
  light = 1.0 - exp(-light * 1.15);
  // The room's own colour where no light falls, so the hero meets the page without a seam.
  light += vec3(0.024, 0.026, 0.034) * (1.0 - light);

  // Dither, so the long gradients don't band.
  light += (hash(pixel + fract(time) * 91.0) - 0.5) * (3.0 / 255.0);
  color = vec4(light, 1.0);
}`;

export interface Light {
  /** Where the beam meets the prism, in CSS pixels from the canvas's top left. */
  aim(x: number, y: number): void;
  stop(): void;
}

const compile = (gl: WebGL2RenderingContext, type: number, source: string) => {
  const shader = gl.createShader(type);
  if (shader === null) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(shader));
    return null;
  }
  return shader;
};

/** Starts the light in a canvas, or returns null where WebGL 2 isn't available (the CSS fallback stays). */
export const startLight = (canvas: HTMLCanvasElement, options: { scale?: number } = {}): Light | null => {
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "low-power" });
  if (gl === null) return null;
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (vertex === null || fragment === null) return null;
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const uniform = (name: string) => gl.getUniformLocation(program, name);
  const resolution = uniform("resolution");
  const time = uniform("time");
  const prism = uniform("prism");
  const turn = uniform("turn");
  const open = uniform("open");
  const arrive = uniform("arrive");
  const lit = uniform("lit");

  const scale = options.scale ?? 0.5;
  const still = matchMedia("(prefers-reduced-motion: reduce)");
  let aimX = 0.3;
  let aimY = 0.5;
  let aimed = false;
  let turnTarget = 0;
  let turnNow = 0;
  let openNow = 0;
  let visible = true;
  let frame = 0;
  const started = performance.now();

  const resize = () => {
    const width = Math.max(1, Math.round(canvas.clientWidth * scale));
    const height = Math.max(1, Math.round(canvas.clientHeight * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
  };

  const draw = (now: number) => {
    resize();
    turnNow += (turnTarget - turnNow) * 0.04;
    const rect = canvas.getBoundingClientRect();
    openNow = Math.min(1, Math.max(0, -rect.top / Math.max(1, rect.height)));
    const x = aimed ? aimX : canvas.clientWidth * aimX;
    const y = aimed ? aimY : canvas.clientHeight * aimY;
    gl.uniform2f(resolution, canvas.width, canvas.height);
    gl.uniform1f(time, still.matches ? 12 : (now - started) / 1000);
    gl.uniform2f(prism, x * scale, y * scale);
    gl.uniform1f(turn, turnNow);
    gl.uniform1f(open, openNow);
    // The beam crosses in under a second, and the spectrum opens over the next one and a half.
    const elapsed = (now - started) / 1000;
    const easeOut = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
    gl.uniform1f(arrive, still.matches ? 1 : easeOut((elapsed - 0.2) / 0.9));
    gl.uniform1f(lit, still.matches ? 1 : easeOut((elapsed - 0.95) / 1.5));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    canvas.dataset["lit"] = "";
  };

  const loop = (now: number) => {
    draw(now);
    frame = visible && !still.matches ? requestAnimationFrame(loop) : 0;
  };
  const wake = () => {
    if (frame === 0) frame = requestAnimationFrame(loop);
  };

  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    if (visible) wake();
  });
  observer.observe(canvas);

  const onPointer = (event: PointerEvent) => {
    turnTarget = (event.clientX / innerWidth - 0.5) * 0.12;
    if (still.matches) return;
    wake();
  };
  addEventListener("pointermove", onPointer, { passive: true });
  const onResize = () => wake();
  addEventListener("resize", onResize);
  still.addEventListener("change", wake);
  wake();

  return {
    aim(x, y) {
      aimX = x;
      aimY = y;
      aimed = true;
      wake();
    },
    stop() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      removeEventListener("pointermove", onPointer);
      removeEventListener("resize", onResize);
    },
  };
};
