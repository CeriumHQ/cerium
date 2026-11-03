import { Glass } from "./steps/Glass.tsx";

/** How long the launch screen waits at most for the GPU to finish building (below). */
const SETTLE_LIMIT_MS = 2_000;
/** Frames this close together, this many in a row, say the GPU is drawing freely again. */
const FREE_FRAME_MS = 34;
const FREE_FRAMES = 4;
/** Frames the GPU gets to begin building in before free frames count: the window has only just shown. */
const FIRST_FRAMES = 8;

/**
 * The welcome's glass step, drawn all but invisibly under the launch screen on what may be a
 * computer's first run, from the launch screen's first paint. The GPU builds the pipelines for each new
 * kind of drawing the first time it meets it, stalling every frame while it does, and on a first run
 * none are built yet; the glass step needs the most of any screen. The launch screen holds its mark and
 * name back while they're built (`gpuSettled`), on the still window, so neither they nor the welcome
 * stutter for them.
 */
export function WelcomeWarmUp() {
  return (
    <div
      data-welcome=""
      aria-hidden="true"
      inert
      className="pointer-events-none fixed inset-0 flex flex-col pt-10 pb-20"
    >
      <section data-state="warm" className="min-h-0 flex-1">
        <Glass number={2} titleId="welcome-warm-up" active={false} />
      </section>
    </div>
  );
}

/**
 * Resolves once frames come freely again, a few in a row, or after a limit. A page hands its frames on
 * without waiting for the GPU to draw them, so two frames after a paint the GPU may not yet have begun
 * the pipelines it needs, and a window's GPU draws nothing until the window shows; once it stalls on
 * them, the frames after wait for it. Aborted, it never resolves.
 */
export const gpuSettled = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const start = performance.now();
    let last = start;
    let frames = 0;
    let free = 0;
    let frame = 0;
    const tick = (now: number) => {
      frames++;
      free = now - last < FREE_FRAME_MS ? free + 1 : 0;
      last = now;
      if ((frames >= FIRST_FRAMES && free >= FREE_FRAMES) || now - start > SETTLE_LIMIT_MS) resolve();
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    signal.addEventListener("abort", () => cancelAnimationFrame(frame));
  });
