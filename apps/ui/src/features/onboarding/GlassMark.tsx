import { useEffect, useRef } from "react";

import { CeriumMark } from "../../components/CeriumMark.tsx";
import { GlassRenderer, type GlassColors } from "./glass.ts";

/** A CSS colour's sRGB channels, as linear light. */
const linear = (color: string): readonly [number, number, number] => {
  const canvas = new OffscreenCanvas(1, 1);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return [1, 1, 1];
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r = 255, g = 255, b = 255] = context.getImageData(0, 0, 1, 1).data;
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return [channel(r), channel(g), channel(b)];
};

/** The glass's colours, from the welcome's tokens on `element`. */
const colorsOf = (element: HTMLElement): GlassColors => {
  const style = getComputedStyle(element);
  return {
    tint: linear(style.getPropertyValue("--welcome-glass")),
    backdrop: linear(style.getPropertyValue("--window")),
    dark: document.documentElement.dataset["theme"] !== "light",
  };
};

/**
 * Cerium's mark in glass, turning slowly in three dimensions (glass.ts) and leaning after the pointer.
 * Where the browser can't draw it, the flat mark stands in.
 */
export function GlassMark({
  running = true,
  className = "",
}: {
  /** Whether it turns: a step on its way out holds it still, so the glass never slows the step's leaving. */
  readonly running?: boolean;
  readonly className?: string;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const control = useRef<{ renderer: GlassRenderer; run: () => void }>(undefined);
  const wanted = useRef(running);

  useEffect(() => {
    const target = canvas.current;
    if (target === null || frame.current === null) return;
    let renderer: GlassRenderer;
    try {
      renderer = new GlassRenderer(target, matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch {
      frame.current.dataset["flat"] = "";
      return;
    }
    const size = () => {
      const box = target.getBoundingClientRect();
      renderer.resize(box.width, box.height, Math.min(2, window.devicePixelRatio || 1));
    };
    size();
    renderer.recolor(colorsOf(target));
    const sized = new ResizeObserver(size);
    sized.observe(target);
    // The theme and its glass can change from the welcome itself.
    const themed = new MutationObserver(() => renderer.recolor(colorsOf(target)));
    themed.observe(document.documentElement, { attributeFilter: ["data-theme", "data-palette"] });
    const point = (event: PointerEvent) => {
      const box = target.getBoundingClientRect();
      renderer.point(
        (event.clientX - (box.left + box.width / 2)) / (window.innerWidth / 2),
        (event.clientY - (box.top + box.height / 2)) / (window.innerHeight / 2),
      );
    };
    window.addEventListener("pointermove", point);
    // It turns only while it's seen.
    let visible = true;
    let shown = !document.hidden;
    const run = () => renderer.run(visible && shown && wanted.current);
    control.current = { renderer, run };
    const seen = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      run();
    });
    seen.observe(target);
    const visibility = () => {
      shown = !document.hidden;
      run();
    };
    document.addEventListener("visibilitychange", visibility);
    run();
    return () => {
      sized.disconnect();
      themed.disconnect();
      seen.disconnect();
      window.removeEventListener("pointermove", point);
      document.removeEventListener("visibilitychange", visibility);
      renderer.dispose();
      control.current = undefined;
    };
  }, []);
  useEffect(() => {
    wanted.current = running;
    control.current?.run();
  }, [running]);

  return (
    <div ref={frame} className={`group relative ${className}`}>
      <canvas
        ref={canvas}
        aria-hidden="true"
        className="absolute inset-0 size-full group-data-flat:hidden forced-colors:hidden"
      />
      <CeriumMark
        size={160}
        className="absolute inset-0 m-auto hidden text-fg-primary group-data-flat:block forced-colors:block"
      />
    </div>
  );
}
