// The hero's scene: Cerium's mark, Prism C, cut from real glass. One white beam comes in from the left,
// passes through the glass and leaves from the facet split into five, one band of the spectrum for
// each harness the lead hands work to. The glass refracts and disperses whatever lies behind it, so
// the beams bend and fringe as the mark turns.
//
// It draws only while the hero is on screen, holds still for reduced motion, and leaves the page's
// fallback in place where WebGL isn't available.

import {
  AdditiveBlending,
  Color,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  Shape,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";

export interface Band {
  readonly color: string;
  /** The label that rides at this band's far end. */
  readonly label: HTMLElement;
}

export interface Prism {
  /** Plays the beam in, splits it and fans the bands out; resolves when they're out. */
  readonly play: () => Promise<void>;
  /** Tints the glass with a theme's hue, in any CSS colour, and takes up the page's new backdrop. */
  readonly tint: (css: string) => void;
}

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A CSS colour as three.js takes it. Three parses only sRGB notations, and the page's colours are
 * oklch and custom properties, so the browser resolves the colour on `within` and paints a pixel of it.
 */
const pixel = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
export const resolveColor = (css: string, within: Element = document.body): Color => {
  const probe = document.createElement("i");
  probe.style.color = css;
  probe.style.display = "none";
  within.append(probe);
  pixel.fillStyle = getComputedStyle(probe).color;
  probe.remove();
  pixel.clearRect(0, 0, 1, 1);
  pixel.fillRect(0, 0, 1, 1);
  const [r, g, b] = pixel.getImageData(0, 0, 1, 1).data;
  return new Color().setRGB(r! / 255, g! / 255, b! / 255, SRGBColorSpace);
};

/** The mark's outline from its 48-unit drawing, centred and scaled down to scene units. */
const markShapes = (): Array<Shape> => {
  const k = 0.1;
  const r = 15 * k;
  const half = 3 * k;
  const from = Math.PI / 4;
  const to = (Math.PI * 7) / 4;
  const ring = new Shape();
  ring.moveTo(Math.cos(from) * (r + half), Math.sin(from) * (r + half));
  ring.absarc(0, 0, r + half, from, to, false);
  ring.absarc(Math.cos(to) * r, Math.sin(to) * r, half, to, to + Math.PI, false);
  ring.absarc(0, 0, r - half, to, from, true);
  ring.absarc(Math.cos(from) * r, Math.sin(from) * r, half, from + Math.PI, from + Math.PI * 2, false);

  const cx = 12 * k;
  const d = 4.5 * k;
  const facet = new Shape();
  facet.moveTo(cx + d, 0);
  facet.lineTo(cx, d);
  facet.lineTo(cx - d, 0);
  facet.lineTo(cx, -d);
  facet.closePath();
  return [ring, facet];
};

/**
 * A dark studio lit by a few thin softboxes, for the glass to reflect. Glass reads as glass by its
 * crisp highlights and clear body; a bright, even room instead lays a soft milky sheen over every
 * face, and the mark looks moulded from acrylic.
 */
const studio = (): Scene => {
  const room = new Scene();
  const panel = (w: number, h: number, strength: number, at: [number, number, number]) => {
    const mesh = new Mesh(
      new PlaneGeometry(w, h),
      new MeshBasicMaterial({ color: new Color().setScalar(strength), side: DoubleSide }),
    );
    mesh.position.set(...at);
    mesh.lookAt(0, 0, 0);
    room.add(mesh);
  };
  // Two tall strips either side of the camera draw long highlight lines down the ring's curves.
  panel(0.35, 9, 14, [-5, 1.5, 6]);
  panel(0.25, 9, 9, [6, -0.5, 5]);
  // A long box overhead catches the top edges; a narrow strip behind lights the rims from within.
  panel(8, 0.8, 6, [0, 7, 1.5]);
  panel(10, 0.4, 3, [0, -3, -8]);
  return room;
};

/**
 * A beam of light: a strip whose brightness falls off across its width and towards its end.
 *
 * This shader and the haze's work out a colour as it shows on screen, then hand three.js its linear
 * value to encode for the canvas: the glass samples a linear copy of the scene, and a shader that
 * wrote screen colours straight out reached it encoded twice, so the glass showed a milky grey.
 */
const beamMaterial = (color: Color, strength: number) =>
  new ShaderMaterial({
    uniforms: {
      uColor: { value: color },
      uReach: { value: 0 },
      uStrength: { value: strength },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uReach;
      uniform float uStrength;
      uniform float uTime;
      varying vec2 vUv;
      void main() {
        float across = abs(vUv.y - 0.5) * 2.0;
        float core = exp(-across * across * 90.0);
        float halo = exp(-across * across * 7.0) * 0.32;
        float along = smoothstep(uReach, uReach - 0.06, vUv.x);
        float tail = mix(1.0, 0.35, smoothstep(0.35, 1.0, vUv.x));
        float shimmer = 0.92 + 0.08 * sin(vUv.x * 40.0 - uTime * 2.2);
        vec3 light = uColor * (core * 1.6 + halo) + vec3(core * 0.55);
        gl_FragColor = sRGBTransferEOTF(vec4(light * along * tail * shimmer * uStrength, 1.0));
        #include <colorspace_fragment>
      }
    `,
    blending: AdditiveBlending,
    depthWrite: false,
    // Kept opaque so the glass's transmission pass, which draws only opaque objects, refracts it.
    transparent: false,
  });

/** A plane whose left edge sits at the origin, so it grows from there. */
const strip = (length: number, width: number) => {
  const geometry = new PlaneGeometry(length, width);
  geometry.translate(length / 2, 0, 0);
  return geometry;
};

export const mountPrism = (canvas: HTMLCanvasElement, bands: ReadonlyArray<Band>): Prism | undefined => {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
  } catch {
    return undefined;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  // No tone mapping: the glass is the only thing it would touch, and Neutral's toe pulls the dim haze
  // the glass refracts down to black, so the mark went opaque against a backdrop it should show.
  renderer.outputColorSpace = SRGBColorSpace;

  const scene = new Scene();
  const background = new Color();
  scene.background = background;
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(studio(), 0).texture;

  const camera = new PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0, 14);

  // The light: in from the far left, out of the facet in a fan.
  const rig = new Group();
  scene.add(rig);
  // The facet's centre once the geometry below is centred on its bounding box.
  const facetX = 1.27;
  const beamIn = new Mesh(strip(24, 0.5), beamMaterial(new Color(1, 1, 1), 1.1));
  beamIn.position.set(facetX - 24, 0, -0.35);
  rig.add(beamIn);
  const fan = bands.map((band, i) => {
    const angle = ((i - (bands.length - 1) / 2) * 8.4 * Math.PI) / 180;
    const mesh = new Mesh(strip(18, 0.42), beamMaterial(resolveColor(band.color), 0.95));
    mesh.position.set(facetX, 0, -0.35);
    mesh.rotation.z = -angle;
    rig.add(mesh);
    return { band, mesh, angle };
  });

  // A slow haze of light behind the glass, so it has something to bend.
  const haze = new Mesh(
    new PlaneGeometry(26, 16),
    new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uTint: { value: new Color(1, 1, 1) } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uTint;
        varying vec2 vUv;
        void main() {
          vec2 p = (vUv - 0.5) * vec2(2.6, 1.6);
          float t = uTime * 0.06;
          float glow = exp(-dot(p, p) * 1.6) * 0.5;
          float folds = sin(p.x * 3.1 + sin(p.y * 2.3 + t * 3.0) * 1.4 + t * 2.0);
          folds = pow(0.5 + 0.5 * folds, 6.0);
          float ribs = pow(0.5 + 0.5 * sin((p.x + p.y * 0.6) * 9.0 - t * 4.0), 14.0) * 0.5;
          float light = glow * (0.22 + folds * 0.6 + ribs);
          gl_FragColor = sRGBTransferEOTF(vec4(uTint * light * 0.32, 1.0));
          #include <colorspace_fragment>
        }
      `,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
  scene.add(haze);

  // The glass itself: polished, with no clearcoat (a second lacquer layer is what plastic has), thick
  // enough to bend what's behind it, and only faintly tinted so the body stays clear.
  const material = new MeshPhysicalMaterial({
    color: new Color(1, 1, 1),
    metalness: 0,
    roughness: 0,
    transmission: 1,
    thickness: 0.8,
    ior: 1.52,
    dispersion: 6,
    specularIntensity: 1,
    attenuationColor: new Color(1, 1, 1),
    attenuationDistance: 6,
    side: DoubleSide,
  });
  // A tight rounded edge: a fat, soft bevel reads as a moulded toy, a narrow one as a polished edge.
  const geometry = new ExtrudeGeometry(markShapes(), {
    depth: 0.84,
    bevelEnabled: true,
    bevelThickness: 0.07,
    bevelSize: 0.05,
    bevelSegments: 6,
    curveSegments: 96,
  });
  geometry.center();
  const mark = new Mesh(geometry, material);
  const pivot = new Group();
  pivot.add(mark);
  scene.add(pivot);

  // Where the mark sits: right of the headline on a wide screen, above it on a narrow one.
  let narrow = false;
  const place = () => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    narrow = width < 760;
    camera.fov = narrow ? 44 : 30;
    camera.updateProjectionMatrix();
    const x = narrow ? -0.9 : Math.min(1.5, camera.aspect * 0.8);
    const y = narrow ? 1.25 : 1.34;
    const scale = narrow ? 0.78 : 0.8;
    pivot.position.set(x, y, 0);
    pivot.scale.setScalar(scale);
    rig.position.set(x, y, 0);
    rig.scale.setScalar(scale);
    haze.position.set(x, y, -3);
    placeLabels();
  };

  // Each label sits a little way along its band, projected onto the page.
  const probe = new Vector3();
  const placeLabels = () => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    rig.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    for (const { band, mesh } of fan) {
      // Along the band to a point just inside the right edge.
      let reach = 2;
      for (; reach < 17; reach += 0.1) {
        probe.set(reach, 0, 0).applyMatrix4(mesh.matrixWorld).project(camera);
        if ((probe.x + 1) / 2 > (narrow ? 0.97 : 0.955)) break;
      }
      probe.set(reach, 0, 0).applyMatrix4(mesh.matrixWorld).project(camera);
      band.label.style.translate = `${((probe.x + 1) / 2) * width}px ${((1 - probe.y) / 2) * height}px`;
    }
  };

  // Pointer tilt, eased.
  const target = { x: 0, y: 0 };
  const tilt = { x: 0, y: 0 };
  addEventListener(
    "pointermove",
    (event) => {
      target.x = (event.clientX / innerWidth - 0.5) * 2;
      target.y = (event.clientY / innerHeight - 0.5) * 2;
    },
    { passive: true },
  );

  let visible = true;
  let frame = 0;
  let started = performance.now();
  const draw = (now: number) => {
    const t = (now - started) / 1000;
    tilt.x += (target.x - tilt.x) * 0.04;
    tilt.y += (target.y - tilt.y) * 0.04;
    const drift = reduced ? 0 : Math.sin(t * 0.35) * 0.28;
    pivot.rotation.set(-0.12 + tilt.y * 0.16, -0.38 + drift + tilt.x * 0.3, 0.04 + tilt.x * 0.03);
    for (const mesh of [haze, beamIn, ...fan.map((f) => f.mesh)]) {
      (mesh.material as ShaderMaterial).uniforms.uTime!.value = t;
    }
    renderer.render(scene, camera);
  };
  const loop = (now: number) => {
    draw(now);
    frame = visible && !reduced ? requestAnimationFrame(loop) : 0;
  };

  new IntersectionObserver(([entry]) => {
    visible = entry!.isIntersecting;
    if (visible && frame === 0 && !reduced) frame = requestAnimationFrame(loop);
  }).observe(canvas);
  new ResizeObserver(() => {
    place();
    if (reduced || frame === 0) draw(performance.now());
  }).observe(canvas);

  const setBackground = () => {
    background.copy(resolveColor("var(--scene)", canvas.parentElement!));
  };
  setBackground();
  place();

  // Reach goes 0 → 1 along each strip; the fan waits for the beam to arrive.
  const reachOf = (mesh: Mesh) => (mesh.material as ShaderMaterial).uniforms.uReach!;
  const tween = (from: number, to: number, ms: number, step: (v: number) => void) =>
    new Promise<void>((resolve) => {
      const begin = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - begin) / ms);
        const eased = 1 - Math.pow(1 - p, 3);
        step(from + (to - from) * eased);
        if (reduced || frame === 0) draw(now);
        if (p < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });

  const play = async () => {
    started = performance.now();
    if (!reduced) frame = requestAnimationFrame(loop);
    if (reduced) {
      for (const mesh of [beamIn, ...fan.map((f) => f.mesh)]) reachOf(mesh).value = 1.1;
      draw(performance.now());
      return;
    }
    await tween(0, 1.06, 1100, (v) => (reachOf(beamIn).value = v));
    await Promise.all(
      fan.map(
        ({ mesh }, i) =>
          new Promise<void>((resolve) =>
            setTimeout(
              () => void tween(0, 1.06, 1500, (v) => (reachOf(mesh).value = v)).then(resolve),
              i * 70,
            ),
          ),
      ),
    );
  };

  const tint = (css: string) => {
    const color = resolveColor(css);
    material.attenuationColor.copy(color);
    (haze.material as ShaderMaterial).uniforms.uTint!.value.copy(color);
    setBackground();
    if (reduced || frame === 0) draw(performance.now());
  };

  return { play, tint };
};
