import { Button } from "@base-ui/react/button";
import { useEffectEvent, useLayoutEffect, useRef, type CSSProperties } from "react";

/**
 * The question a new thread asks, a line at a time: each line is set whole, and the page never rewraps
 * it. `measure` is its longest line's width in ems, so any question takes the same share of the pane.
 */
const QUESTIONS = {
  work: { lines: ["What should", "we work on?"], measure: 7.24 },
  chat: { lines: ["What would you", "like to know?"], measure: 9.1 },
  setUp: { lines: ["No harness", "is ready"], measure: 6.76 },
} as const;

/** The space between the question and the message box seated under it. */
const SEAT_GAP = 28;
/** Half the empty message box's height: seated, its middle lands on the pane's, where the eye goes first. */
const BOX_MIDDLE = 47;
/** The width from which the box sits under the question; a phone keeps it at the foot, over the keyboard. */
const SEATED = "(min-width: 48rem)";

/**
 * Where a new thread starts, behind the message box: the question it asks. Only a chat says anything
 * beyond the question, since its limits aren't on the box, and a machine with no harness ready says
 * what to do first.
 */
export function EmptyThread({
  mode,
  onSetUp,
  onSeat,
}: {
  mode: "work" | "chat";
  /** No harness can run a thread yet: opens where one is set up. */
  onSetUp?: () => void;
  /**
   * Where the message box sits, in the window's coordinates: under the question, so the two read as
   * one. Undefined on a phone, and once the question goes, which drops the box to the pane's foot.
   */
  onSeat?: (seat: number | undefined) => void;
}) {
  const question = onSetUp ? QUESTIONS.setUp : QUESTIONS[mode];
  const glass = useRef<HTMLDivElement>(null);

  // The box's seat follows the question's foot as the page lays it out, before it's painted, so the box
  // never shows at the pane's foot first.
  const said = useRef<HTMLDivElement>(null);
  const seatOf = () => {
    const block = said.current;
    return block !== null && matchMedia(SEATED).matches
      ? block.getBoundingClientRect().bottom + SEAT_GAP
      : undefined;
  };
  const seat = useEffectEvent((seated: boolean) => {
    onSeat?.(seated ? seatOf() : undefined);
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

  return (
    <div ref={glass} className="relative h-full overflow-hidden [container-type:size]">
      {/* Seated, the question stands over the pane's middle, which the message box takes. */}
      <div
        style={{ "--seat": `${BOX_MIDDLE + SEAT_GAP}px` } as CSSProperties}
        className="relative flex h-full flex-col items-center justify-center px-6 pb-32 md:[justify-content:safe_flex-end] md:pb-[calc(50cqb+var(--seat))]"
      >
        <div ref={said} className="flex max-w-full flex-col items-center text-center">
          {/* A heading over the box rather than a poster behind it: its longest line spans most of a phone
              and about two thirds of the box. Each line comes into focus in turn as the pane opens. */}
          <h1
            style={{ "--measure": question.measure } as CSSProperties}
            className="font-display text-[length:min(calc(min(76cqi,420px)/var(--measure)),9cqb)] leading-[1.08] font-light tracking-[-0.015em] text-balance text-fg-secondary font-stretch-expanded [font-size-adjust:none]"
          >
            {question.lines.map((line, index) => (
              <span
                key={line}
                style={{ animationDelay: `${index * 90}ms` }}
                className="block animate-[question-settle_640ms_cubic-bezier(0.2,0.8,0.2,1)_backwards] whitespace-nowrap motion-reduce:animate-none"
              >
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
