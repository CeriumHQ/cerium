import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { ChapterId } from "./model.ts";
import { Prism, readPalette, type BeamPose, type PrismPose } from "./prism.ts";

/** The stage a chapter poses the light on: its size, and the element its parts are measured from. */
export interface Stage {
  readonly width: number;
  readonly height: number;
  readonly element: HTMLElement;
}

/** A chapter's pose for the light, worked out afresh whenever the stage changes size. */
export type Posing = (stage: Stage) => PrismPose;

interface Scene {
  /** Takes `posing` as the light's pose from now on. */
  readonly pose: (posing: Posing) => void;
  /** Runs a pulse down the light. */
  readonly pulse: () => void;
}

const SceneContext = createContext<Scene | undefined>(undefined);

/**
 * The welcome's light, behind everything on its stage (prism.ts), and the context its chapters pose
 * it through. It follows the stage's size, the theme and the pointer, and rests while the page is
 * hidden.
 */
export function SceneProvider({
  className = "",
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const glowCanvas = useRef<HTMLCanvasElement>(null);
  const [scene] = useState(() => {
    let prism: Prism | undefined;
    let posing: Posing | undefined;
    const apply = () => {
      const element = stage.current;
      if (prism === undefined || posing === undefined || element === null) return;
      prism.pose(posing({ width: element.clientWidth, height: element.clientHeight, element }));
    };
    return {
      attach: (attached: Prism | undefined) => {
        prism = attached;
        apply();
      },
      apply,
      pose: (next: Posing) => {
        posing = next;
        apply();
      },
      pulse: () => prism?.pulse(),
    };
  });

  useLayoutEffect(() => {
    const element = stage.current;
    const target = canvas.current;
    const glow = glowCanvas.current;
    if (element === null || target === null || glow === null) return;
    const prism = new Prism(target, glow, matchMedia("(prefers-reduced-motion: reduce)").matches);
    const size = () => {
      prism.resize(element.clientWidth, element.clientHeight, Math.min(2, window.devicePixelRatio || 1));
      scene.apply();
    };
    size();
    prism.recolor(readPalette(element));
    scene.attach(prism);

    const sized = new ResizeObserver(size);
    sized.observe(element);
    // The theme and its palette can change from the welcome itself.
    const themed = new MutationObserver(() => prism.recolor(readPalette(element)));
    themed.observe(document.documentElement, { attributeFilter: ["data-theme", "data-palette"] });
    const point = (event: PointerEvent) => {
      const box = element.getBoundingClientRect();
      prism.point(
        ((event.clientX - box.left) / box.width) * 2 - 1,
        ((event.clientY - box.top) / box.height) * 2 - 1,
      );
    };
    element.addEventListener("pointermove", point);
    // A click on the stage, not on one of its controls, sends a pulse down the light.
    const press = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : undefined;
      if (event.button !== 0 || target?.closest("button, a, input, textarea, [role='radio']") != null) return;
      prism.pulse();
    };
    element.addEventListener("pointerdown", press);
    const visibility = () => {
      prism.hidden = document.hidden;
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      sized.disconnect();
      themed.disconnect();
      element.removeEventListener("pointermove", point);
      element.removeEventListener("pointerdown", press);
      document.removeEventListener("visibilitychange", visibility);
      scene.attach(undefined);
      prism.dispose();
    };
  }, [scene]);

  return (
    <SceneContext value={scene}>
      <div ref={stage} className={`absolute inset-0 ${className}`}>
        <canvas
          ref={glowCanvas}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 size-full forced-colors:hidden"
        />
        <canvas
          ref={canvas}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 size-full forced-colors:hidden"
        />
        {children}
      </div>
    </SceneContext>
  );
}

const useScene = () => {
  const scene = use(SceneContext);
  if (scene === undefined) throw new Error("A welcome chapter poses the light only inside SceneProvider");
  return scene;
};

/**
 * Poses the light for the chapter while it's the one showing, and again whenever `key` changes: say,
 * as what its beams point at changes. Posed after layout, so the chapter's parts can be measured.
 */
export const usePose = (active: boolean, posing: Posing, key?: unknown) => {
  const scene = useScene();
  const latest = useEffectEvent(posing);
  useLayoutEffect(() => {
    if (active) scene.pose((stage) => latest(stage));
  }, [active, key, scene]);
};

/** Runs a pulse down the light. */
export const usePulse = () => useScene().pulse;

/** Runs `effect` once the chapter has come in and settled: its parts measure where they rest. */
export const useSettled = (active: boolean, effect: () => void, delay = 1_200) => {
  const latest = useEffectEvent(effect);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => latest(), delay);
    return () => clearTimeout(timer);
  }, [active, delay]);
};

/**
 * Where the part marked `data-light={name}` sits on the stage, by layout: inside `chapter`'s section
 * when given, since the chapter on its way out may mark parts of the same name.
 */
export const lightOf = (stage: Stage, name: string, chapter?: ChapterId) =>
  placeOf(
    stage.element.querySelector<HTMLElement>(
      `${chapter === undefined ? "" : `[data-chapter="${chapter}"] `}[data-light="${name}"]`,
    ),
    stage.element,
  );

/**
 * The mark as drawn in `chapter`'s square marked `data-light="mark"`, filling it, or at `fallback`
 * before it's laid out: its ring's centre (a little left of the square's, so the beams have room),
 * its size, and the facet the beams leave from.
 */
export const markIn = (
  stage: Stage,
  chapter: ChapterId,
  fallback: { readonly x: number; readonly y: number; readonly size: number },
) => {
  const slot = lightOf(stage, "mark", chapter);
  const size = slot?.width ?? fallback.size;
  const x = slot === undefined ? fallback.x : slot.x + size / 2 - size * 0.08;
  const y = slot === undefined ? fallback.y : slot.y + size / 2;
  return { x, y, size, facet: { x: x + size * 0.34, y } };
};

/** Where `element` sits on the stage, by layout: what it's moving through as it comes in doesn't count. */
const placeOf = (element: HTMLElement | null, stage: HTMLElement) => {
  if (element === null) return undefined;
  let x = 0;
  let y = 0;
  let at: HTMLElement | null = element;
  while (at !== null && at !== stage) {
    x += at.offsetLeft;
    y += at.offsetTop;
    const parent: Element | null = at.offsetParent;
    at = parent instanceof HTMLElement ? parent : null;
  }
  // The stage may not be an offset parent: measure the rest of the way from the page.
  if (at !== stage) {
    const box = element.getBoundingClientRect();
    const origin = stage.getBoundingClientRect();
    return { x: box.left - origin.left, y: box.top - origin.top, width: box.width, height: box.height };
  }
  return { x, y, width: element.offsetWidth, height: element.offsetHeight };
};

/**
 * The five beams fanned out from the facet towards the stage's right edge, bending a little down as
 * light through a prism does, `spread` apart where they leave the stage.
 */
export const fan = (
  stage: Stage,
  mark: { readonly x: number; readonly y: number },
  spread: number,
  intensity: number | ReadonlyArray<number> = 1,
): ReadonlyArray<BeamPose> =>
  [0, 1, 2, 3, 4].map((index) => ({
    x: stage.width + 60,
    y: mark.y + stage.height * 0.06 + (index - 2) * spread,
    intensity: typeof intensity === "number" ? intensity : (intensity[index] ?? 0),
  }));
