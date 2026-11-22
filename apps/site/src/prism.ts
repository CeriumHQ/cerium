// The hero's scene: Cerium's mark, Prism C, cut from real glass. One white beam comes in from the left,
// passes through the glass and leaves from the facet split into one band of the spectrum for each
// harness the lead hands work to. The glass refracts and disperses whatever lies behind it, so
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
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  Object3D,
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
  /** Plays the beam in, splits it and fans the bands out. */
  readonly play: () => void;
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
  if (/^#[0-9a-f]{6}$/i.test(css)) return new Color(css);
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
const beamMaterial = () =>
  new ShaderMaterial({
    uniforms: {
      uStill: { value: reduced },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform bool uStill;
      varying vec2 vUv;
      varying vec3 vBeamColor;
      varying float vReach;
      varying float vStrength;
      void main() {
        vUv = uv;
        vBeamColor = instanceColor;
        bool incoming = gl_InstanceID == 0;
        vStrength = incoming ? 1.1 : 0.95;
        float delay = incoming ? 0.0 : 1.1 + float(gl_InstanceID - 1) * 0.055;
        float progress = clamp((uTime - delay) / (incoming ? 1.1 : 1.5), 0.0, 1.0);
        float left = 1.0 - progress;
        vReach = uStill ? 1.1 : 1.06 * (1.0 - left * left * left);
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 vBeamColor;
      varying float vReach;
      varying float vStrength;
      void main() {
        float across = abs(vUv.y - 0.5) * 2.0;
        float core = exp(-across * across * 90.0);
        float halo = exp(-across * across * 7.0) * 0.32;
        float along = smoothstep(vReach, vReach - 0.06, vUv.x);
        float tail = mix(1.0, 0.35, smoothstep(0.35, 1.0, vUv.x));
        float shimmer = 0.92 + 0.08 * sin(vUv.x * 40.0 - uTime * 2.2);
        vec3 light = vBeamColor * (core * 1.6 + halo) + vec3(core * 0.55);
        gl_FragColor = sRGBTransferEOTF(vec4(light * along * tail * shimmer * vStrength, 1.0));
        #include <colorspace_fragment>
      }
    `,
    blending: AdditiveBlending,
    depthWrite: false,
    // Kept opaque so the glass's transmission pass, which draws only opaque objects, refracts it.
    transparent: false,
  });

/** The height the top bar takes, in pixels, with the air under it. */
const BAR = 76;

/** A plane whose left edge sits at the origin, so it grows from there. */
const strip = (length: number, width: number) => {
  const geometry = new PlaneGeometry(length, width);
  geometry.translate(length / 2, 0, 0);
  return geometry;
};

/** `copy` is the headline and what follows it, which the scene stays clear of where it sits above them. */
export const mountPrism = (
  canvas: HTMLCanvasElement,
  bands: ReadonlyArray<Band>,
  copy: HTMLElement,
): Prism | undefined => {
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
  const room = studio();
  scene.environment = pmrem.fromScene(room).texture;
  pmrem.dispose();
  for (const panel of room.children) {
    if (panel instanceof Mesh) {
      panel.geometry.dispose();
      panel.material.dispose();
    }
  }

  const camera = new PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(0, 0, 14);

  // The light: in from the far left, out of the facet in a fan.
  const rig = new Group();
  scene.add(rig);
  // The facet's centre once the geometry below is centred on its bounding box.
  const facetX = 1.27;
  // The transmission pass and the visible pass each draw the whole fan in one submission.
  const beams = new InstancedMesh(strip(18, 0.42), beamMaterial(), bands.length + 1);
  beams.setMatrixAt(0, new Matrix4().makeScale(24 / 18, 0.5 / 0.42, 1).setPosition(facetX - 24, 0, -0.35));
  beams.setColorAt(0, new Color(1, 1, 1));
  rig.add(beams);
  const fan = bands.map((band, i) => {
    const anchor = new Object3D();
    anchor.position.set(facetX, 0, -0.35);
    rig.add(anchor);
    beams.setColorAt(i + 1, resolveColor(band.color));
    return { band, anchor, offset: i - (bands.length - 1) / 2 };
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
  // The glass samples the scene in screen space and has no UV-mapped textures.
  geometry.deleteAttribute("uv");
  geometry.center();
  const mark = new Mesh(geometry, material);
  const pivot = new Group();
  pivot.add(mark);
  scene.add(pivot);

  // Where the mark sits: right of the headline on a wide screen, above it on a narrow one.
  let narrow = false;
  let sized = { width: 0, height: 0 };
  const place = (width: number, height: number) => {
    sized = { width, height };
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    narrow = width < 760 || width < height;
    camera.fov = narrow ? 44 : 30;
    camera.updateProjectionMatrix();
    // The fan keeps the spread it was drawn with for eight harnesses, however many there are.
    const spread = ((narrow ? 73.5 : 49.7) * Math.PI) / 180;
    const step = spread / Math.max(1, fan.length - 1);
    fan.forEach(({ anchor, offset }, i) => {
      anchor.rotation.z = -(offset * step);
      anchor.updateMatrix();
      beams.setMatrixAt(i + 1, anchor.matrix);
    });
    beams.instanceMatrix.needsUpdate = true;
    beams.computeBoundingSphere();
    const x = narrow ? -0.9 : Math.min(1.5, camera.aspect * 0.8);
    // On a narrow screen the mark and its fan sit in the middle of what's left between the top bar
    // and the copy, however tall the copy runs, and shrink when that is less than the labels need.
    const tall = 2 * camera.position.z * Math.tan((camera.fov * Math.PI) / 360);
    const room = copy.offsetTop - BAR;
    const y = narrow ? (0.5 - (BAR + room / 2) / height) * tall : 1.34;
    const scale = narrow ? 0.78 * Math.min(1, Math.max(0.6, room / 300)) : 0.8;
    pivot.position.set(x, y, 0);
    pivot.scale.setScalar(scale);
    rig.position.set(x, y, 0);
    rig.scale.setScalar(scale);
    haze.position.set(x, y, -3);
    placeLabels(width, height);
  };

  // Each label sits a little way along its band, projected onto the page.
  const probe = new Vector3();
  const placeLabels = (width: number, height: number) => {
    rig.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    const spots: Array<{ label: HTMLElement; x: number; y: number }> = [];
    for (const { band, anchor } of fan) {
      // Along the band to a point just inside the right edge.
      let reach = 2;
      for (; reach < 17; reach += 0.1) {
        probe.set(reach, 0, 0).applyMatrix4(anchor.matrixWorld).project(camera);
        if ((probe.x + 1) / 2 > (narrow ? 0.97 : 0.955)) break;
      }
      probe.set(reach, 0, 0).applyMatrix4(anchor.matrixWorld).project(camera);
      spots.push({ label: band.label, x: ((probe.x + 1) / 2) * width, y: ((1 - probe.y) / 2) * height });
    }
    // The fan is steep near its ends, so pills can crowd each other; nudge them apart, top to bottom,
    // then recentre the stack on where the fan's middle sits.
    const gap = narrow ? 5 : 8;
    const heights = spots.map((s) => s.label.offsetHeight || (narrow ? 27 : 32));
    const wanted = spots.map((s) => s.y);
    for (let i = 1; i < spots.length; i++) {
      const least = spots[i - 1]!.y + (heights[i - 1]! + heights[i]!) / 2 + gap;
      if (spots[i]!.y < least) spots[i]!.y = least;
    }
    const shift =
      wanted.reduce((sum, y) => sum + y, 0) / spots.length -
      spots.reduce((sum, s) => sum + s.y, 0) / spots.length;
    for (const { label, x, y } of spots) label.style.translate = `${x}px ${y + shift}px`;
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

  let visible = false;
  let frame = 0;
  let started: number | undefined;
  const draw = (now: number) => {
    frame = 0;
    if (started === undefined || !visible || document.hidden) return;
    const elapsed = Math.max(0, now - started);
    const t = elapsed / 1000;
    tilt.x += (target.x - tilt.x) * 0.04;
    tilt.y += (target.y - tilt.y) * 0.04;
    const drift = reduced ? 0 : Math.sin(t * 0.35) * 0.28;
    pivot.rotation.set(-0.12 + tilt.y * 0.16, -0.38 + drift + tilt.x * 0.3, 0.04 + tilt.x * 0.03);
    beams.material.uniforms.uTime!.value = t;
    haze.material.uniforms.uTime!.value = t;
    renderer.render(scene, camera);
    if (!reduced) requestDraw();
  };
  const requestDraw = () => {
    if (started !== undefined && frame === 0 && visible && !document.hidden)
      frame = requestAnimationFrame(draw);
  };

  new IntersectionObserver(
    ([entry]) => {
      visible = entry!.intersectionRatio >= 0.001;
      requestDraw();
    },
    { threshold: 0.001 },
  ).observe(canvas);
  document.addEventListener("visibilitychange", requestDraw);
  let clear = copy.offsetTop;
  const resized = new ResizeObserver(() => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    // The copy grows as its fonts arrive, which moves its top without resizing the canvas.
    if (width === sized.width && height === sized.height && copy.offsetTop === clear) return;
    clear = copy.offsetTop;
    place(width, height);
    requestDraw();
  });
  resized.observe(canvas);
  resized.observe(copy);

  place(canvas.clientWidth, canvas.clientHeight);
  const play = () => {
    started = performance.now();
    requestDraw();
  };

  const tint = (css: string) => {
    const color = resolveColor(css);
    material.attenuationColor.copy(color);
    (haze.material as ShaderMaterial).uniforms.uTint!.value.copy(color);
    background.copy(resolveColor("var(--scene)", canvas.parentElement!));
    requestDraw();
  };

  return { play, tint };
};
