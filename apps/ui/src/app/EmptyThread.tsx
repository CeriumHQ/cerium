import { Button } from "@base-ui/react/button";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, type CSSProperties } from "react";

import { draftLengthAtom } from "../features/composer/drafts.ts";
import { Frost, readScene } from "./frost.ts";

/**
 * The question a new thread asks, a line at a time: each line is set whole, and the page never rewraps
 * it. `measure` is its longest line's width in ems, so any question takes the same share of the pane.
 */
const QUESTIONS = {
  work: { lines: ["What should", "we work on?"], measure: 7.24 },
  chat: { lines: ["What would you", "like to know?"], measure: 9.1 },
  setUp: { lines: ["No harness", "is ready"], measure: 6.76 },
} as const;

/** The question's font, which the glass waits on so it never draws a fallback's shapes. */
const QUESTION_FONT = '200 expanded 64px "Anybody Variable"';
/** How long the pane's size keeps still before the glass is drawn again for it. */
const SETTLE_MS = 150;
/** The space between the question and the message box seated under it. */
const SEAT_GAP = 28;
/** The width from which the box sits under the question; a phone keeps it at the foot, over the keyboard. */
const SEATED = "(min-width: 48rem)";

/**
 * Where a new thread starts, behind the message box: frosted glass over the window, the question
 * showing through it. The pointer polishes the glass clear where it passes, typing in the message box
 * wipes the question clear a letter at a time, and the fog comes back over what's left alone
 * (app/frost.ts). Only a chat says anything beyond the question, since its limits aren't on the box,
 * and a machine with no harness ready says what to do first.
 */
export function EmptyThread({
  mode,
  draftKey,
  onSetUp,
  onSeat,
}: {
  mode: "work" | "chat";
  /** The draft the message box writes, whose typing wipes the question. */
  draftKey: string;
  /** No harness can run a thread yet: opens where one is set up. */
  onSetUp?: () => void;
  /**
   * Where the message box sits, in the window's coordinates: under the question, so the two read as
   * one. Undefined on a phone, and once the question goes, which drops the box to the pane's foot.
   */
  onSeat?: (seat: number | undefined) => void;
}) {
  const question = onSetUp ? QUESTIONS.setUp : QUESTIONS[mode];
  const typed = useAtomValue(draftLengthAtom(draftKey));
  const glass = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const headline = useRef<HTMLHeadingElement>(null);
  const cloth = useRef<HTMLDivElement>(null);
  const frost = useRef<Frost | null>(null);
  const asked = question.lines.join("\n");

  // The box's seat follows the question's foot as the page lays it out, before it's painted, so the box
  // never shows at the pane's foot first.
  const said = useRef<HTMLDivElement>(null);
  const seat = useEffectEvent((seated: boolean) => {
    const block = said.current;
    onSeat?.(seated && block !== null ? block.getBoundingClientRect().bottom + SEAT_GAP : undefined);
  });
  useLayoutEffect(() => {
    const surface = glass.current;
    const block = said.current;
    if (surface === null || block === null) return;
    const wide = matchMedia(SEATED);
    const place = () => seat(wide.matches);
    place();
    const moved = new ResizeObserver(place);
    moved.observe(surface);
    moved.observe(block);
    return () => {
      moved.disconnect();
      seat(false);
    };
  }, []);

  useEffect(() => {
    const surface = glass.current;
    const target = canvas.current;
    const heading = headline.current;
    const rag = cloth.current;
    if (surface === null || target === null || heading === null || rag === null) return;
    const pane = new Frost(target, surface, rag, matchMedia("(prefers-reduced-motion: reduce)").matches);
    frost.current = pane;

    // The glass follows the page: its size, the window's scale and zoom, the theme, and the font.
    let frame = 0;
    let settling: ReturnType<typeof setTimeout> | undefined;
    let shown: { readonly width: number; readonly height: number } | undefined;
    const measure = () => {
      cancelAnimationFrame(frame);
      clearTimeout(settling);
      frame = requestAnimationFrame(() => {
        if (!document.fonts.check(QUESTION_FONT)) {
          void document.fonts.load(QUESTION_FONT).then(measure, () => undefined);
          return;
        }
        const scene = readScene(surface, heading);
        if (scene === undefined) return;
        pane.show(scene);
        shown = scene;
      });
    };
    measure();
    // Drawing the glass takes longer than a frame, so while the pane is resized its last drawing holds,
    // and the glass is drawn again once the size settles.
    const sized = new ResizeObserver(() => {
      if (shown === undefined) return measure();
      const box = surface.getBoundingClientRect();
      if (box.width === shown.width && box.height === shown.height) return;
      pane.hold(heading);
      clearTimeout(settling);
      settling = setTimeout(measure, SETTLE_MS);
    });
    sized.observe(surface);
    const themed = new MutationObserver(measure);
    themed.observe(document.documentElement, { attributeFilter: ["data-theme", "data-palette"] });
    document.fonts.addEventListener("loadingdone", measure);
    let density = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const rescaled = () => {
      density.removeEventListener("change", rescaled);
      density = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      density.addEventListener("change", rescaled);
      measure();
    };
    density.addEventListener("change", rescaled);

    // The first wipe plays where it's seen: once the launch screen hands the window over, if it's up.
    const launching = surface.closest("[data-launching]");
    let greeting: ReturnType<typeof setTimeout> | undefined;
    const greet = (delay: number) => {
      greeting = setTimeout(() => pane.greet(), delay);
    };
    const launched = new MutationObserver(() => {
      if (launching?.hasAttribute("data-launching") === true) return;
      launched.disconnect();
      greet(320);
    });
    if (launching === null) greet(120);
    else launched.observe(launching, { attributeFilter: ["data-launching"] });

    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settling);
      clearTimeout(greeting);
      sized.disconnect();
      themed.disconnect();
      launched.disconnect();
      document.fonts.removeEventListener("loadingdone", measure);
      density.removeEventListener("change", rescaled);
      pane.dispose();
      frost.current = null;
    };
  }, [asked]);

  useEffect(() => {
    frost.current?.reveal(typed);
  }, [typed, asked]);

  return (
    <div ref={glass} className="relative h-full touch-none overflow-hidden [container-type:size]">
      <canvas
        ref={canvas}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 size-full forced-colors:hidden"
      />
      {/* The cloth: where the pointer polishes, while it moves over fog. */}
      <div
        ref={cloth}
        aria-hidden="true"
        className="pointer-events-none absolute top-0 left-0 rounded-full border border-line-subtle opacity-0 transition-opacity duration-500 data-[on]:opacity-(--fog) data-[on]:duration-150"
      />
      <div className="relative flex h-full flex-col items-center justify-center px-6 pb-32">
        <div ref={said} className="flex max-w-full flex-col items-start">
          {/* Laid out by the page and drawn by the glass; screen readers and high contrast read it here.
              Its longest line spans most of a phone and less of a wide pane, and never crowds a short one. */}
          <h1
            ref={headline}
            style={{ "--measure": question.measure } as CSSProperties}
            className="font-display text-[length:min(calc(min(61.5cqi_+_70px,84cqi)/var(--measure)),16cqb,148px)] leading-[1.04] font-extralight tracking-[-0.01em] text-transparent font-stretch-expanded [font-size-adjust:none] forced-colors:text-[CanvasText]"
          >
            {question.lines.map((line) => (
              <span key={line} className="block whitespace-nowrap">
                {line}
              </span>
            ))}
          </h1>
          {onSetUp ? (
            <>
              <p className="mt-[clamp(14px,3cqb,28px)] max-w-sm text-body leading-relaxed text-fg-tertiary">
                Set up Claude, Codex, Muse, Cursor or OpenCode to start.
              </p>
              <Button
                onClick={onSetUp}
                className="mt-3 flex h-8 items-center rounded-lg bg-accent px-3 text-meta font-medium text-accent-fg transition-opacity hover:opacity-90 active:opacity-80"
              >
                Set up a harness
              </Button>
            </>
          ) : mode === "chat" ? (
            <p className="mt-[clamp(14px,3cqb,28px)] max-w-sm text-body leading-relaxed text-fg-tertiary">
              Chats read and search the web, and never change your files.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
