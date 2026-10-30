import { Button } from "@base-ui/react/button";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { HISTORY_EVENT } from "./HistoryWindow.tsx";
import type { Item } from "./layout.ts";
import { REVEAL_EVENT } from "./useStickToBottom.ts";

/** One of the user's prompts, as the stepper marks it. */
export interface Prompt {
  /** The id of the prompt's item, which its element in the conversation carries as `data-prompt`. */
  readonly id: string;
  /** What the prompt said, on one line, or the files it sent when it said nothing. */
  readonly label: string;
}

/** The user's prompts in order, one per message they sent (a version a rewind replaced has none). */
export const promptsOf = (items: ReadonlyArray<Item>): ReadonlyArray<Prompt> =>
  items.flatMap((item) => {
    if (item.kind !== "input") return [];
    const said = item.blocks.flatMap((block) => (block.kind === "user" ? [block] : []));
    const text = said
      .map((block) => block.text.trim())
      .filter((each) => each !== "")
      .join(" ")
      .replace(/\s+/g, " ");
    const files = said.flatMap((block) => block.attachments.map((file) => file.name));
    const label = text !== "" ? text : files.join(", ");
    return label === "" ? [] : [{ id: item.id, label }];
  });

/** A prompt's mark grows with what it said, so a long brief stands out from a quick follow-up. */
export const markWidth = (label: string): number =>
  Math.round(8 + 10 * Math.min(1, Math.log10(Math.max(1, label.length)) / 3));

/** How far below the viewport's top a prompt still counts as the one being read, as a share of its height. */
const READING_LINE = 0.3;
/** How long a jump waits for older history to come in before giving up, in milliseconds. */
const JUMP_WAIT_MS = 1000;
const MARK_HEIGHT = 10;
const MOUNTED_MARKS = 128;

const promptElement = (viewport: HTMLElement, id: string) =>
  viewport.querySelector<HTMLElement>(`[data-prompt="${CSS.escape(id)}"]`);

/**
 * Brings a prompt to the viewport's top. Reading back stops the conversation following its end, and
 * brings in history the window hasn't drawn yet, which can take a frame or two.
 */
const bringToTop = (viewport: HTMLElement, id: string) => {
  viewport.dispatchEvent(new Event(REVEAL_EVENT, { bubbles: true }));
  const drawn = promptElement(viewport, id) !== null;
  if (!drawn) window.dispatchEvent(new CustomEvent(HISTORY_EVENT, { detail: { id } }));
  const deadline = performance.now() + JUMP_WAIT_MS;
  const go = () => {
    const target = promptElement(viewport, id);
    if (target === null) {
      if (performance.now() < deadline) requestAnimationFrame(go);
      return;
    }
    const top =
      viewport.scrollTop + target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 16;
    const smooth = drawn && !matchMedia("(prefers-reduced-motion: reduce)").matches;
    viewport.scrollTo({ top, behavior: smooth ? "smooth" : "instant" });
  };
  go();
};

/**
 * Marks down the transcript's left edge, one per prompt the user sent: the one being read stands
 * out, hovering one shows what it said, and clicking it brings it to the top.
 */
export function PromptStepper({
  prompts,
  viewport,
  onReveal,
}: {
  prompts: ReadonlyArray<Prompt>;
  viewport: RefObject<HTMLDivElement | null>;
  onReveal?: (() => void) | undefined;
}) {
  const [reading, setReading] = useState<string>();
  const strip = useRef<HTMLDivElement>(null);
  const ids = prompts.map((prompt) => prompt.id).join(" ");
  const [first, setFirst] = useState(() => Math.max(0, prompts.length - MOUNTED_MARKS));
  const start = Math.min(first, Math.max(0, prompts.length - MOUNTED_MARKS));
  const end = Math.min(prompts.length, start + MOUNTED_MARKS);
  const readingIndex =
    reading === undefined ? prompts.length - 1 : prompts.findIndex((prompt) => prompt.id === reading);

  // Which prompt is being read follows the scroll: the last one above the reading line, or at the
  // end, the last one in view.
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const order = ids === "" ? [] : ids.split(" ");
    let frame = 0;
    const measure = () => {
      frame = 0;
      const box = element.getBoundingClientRect();
      const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
      const line = atEnd ? box.bottom : box.top + box.height * READING_LINE;
      // A bounded window has undrawn prompts on both sides. Measure only mounted prompts, whose
      // DOM order is the conversation's order, rather than treating every missing prompt as older.
      const mounted = [...element.querySelectorAll<HTMLElement>("[data-prompt]")];
      let found = mounted[0]?.dataset["prompt"] ?? order[0];
      for (const prompt of mounted) {
        const top = prompt.getBoundingClientRect().top;
        if (top > line) break;
        found = prompt.dataset["prompt"];
      }
      setReading(found);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    element.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => {
      element.removeEventListener("scroll", schedule);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [ids, viewport]);

  // A long thread's marks scroll in their strip, which keeps the one being read in view.
  useLayoutEffect(() => {
    const element = strip.current;
    if (!element || readingIndex < 0) return;
    const top = readingIndex * MARK_HEIGHT;
    if (top < element.scrollTop || top + MARK_HEIGHT > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, top - element.clientHeight / 2);
    }
  }, [readingIndex]);

  if (prompts.length < 2) return null;
  return (
    <nav
      aria-label="Prompts"
      className="absolute top-1/2 left-1.5 z-10 -translate-y-1/2 max-md:hidden pointer-coarse:hidden"
    >
      <div
        ref={strip}
        onScroll={(event) =>
          setFirst(Math.max(0, Math.floor(event.currentTarget.scrollTop / MARK_HEIGHT) - 20))
        }
        className="group/steps flex max-h-[min(60vh,32rem)] flex-col overflow-y-auto [scrollbar-width:none]"
      >
        <div aria-hidden className="shrink-0" style={{ height: start * MARK_HEIGHT }} />
        {prompts.slice(start, end).map((prompt) => {
          const current = prompt.id === reading;
          return (
            <Tooltip
              key={prompt.id}
              side="right"
              label={<span className="line-clamp-3">{prompt.label}</span>}
            >
              <Button
                data-mark={prompt.id}
                aria-label={prompt.label}
                aria-current={current ? "location" : undefined}
                onClick={() => {
                  onReveal?.();
                  if (viewport.current) bringToTop(viewport.current, prompt.id);
                }}
                className="group/mark flex h-2.5 w-7 shrink-0 items-center px-1.5 outline-none"
              >
                <span
                  style={{ width: markWidth(prompt.label) }}
                  className={`h-0.5 rounded-full transition-colors duration-150 group-hover/mark:bg-fg-primary group-focus-visible/mark:bg-fg-primary ${
                    current ? "bg-fg-primary" : "bg-fg-disabled group-hover/steps:bg-fg-tertiary"
                  }`}
                />
              </Button>
            </Tooltip>
          );
        })}
        <div aria-hidden className="shrink-0" style={{ height: (prompts.length - end) * MARK_HEIGHT }} />
      </div>
    </nav>
  );
}
