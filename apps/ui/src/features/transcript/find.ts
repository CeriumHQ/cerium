import { Atom } from "effect/reactivity";

import type { Piece } from "../threads/threadSearch.ts";
import { REVEAL_EVENT } from "./useStickToBottom.ts";

/** Dispatched on the window to open the find bar of the thread the focused pane shows. */
export const FIND_EVENT = "cerium:find";

/** Dispatched from inside a folded message, which opens its fold so a match in it shows. */
export const UNFOLD_EVENT = "cerium:unfold";

/** How long a jump waits for its thread to draw the message; a jump older than this is dropped. */
export const JUMP_WAIT_MS = 4000;

/** How long a jump's words stay marked, and a message stays ringed. */
const MARK_MS = 2400;
const RING_MS = 1700;

/** Opens the find bar of the focused thread. */
export const openFind = (): void => {
  window.dispatchEvent(new Event(FIND_EVENT));
};

/** A message the command palette picked from a search: its thread scrolls to it and marks the words. */
export interface FindJump {
  readonly threadId: string;
  /** The passage the search showed, whose matched words are the pieces marked. */
  readonly passage: ReadonlyArray<Piece>;
  /** When it was picked, in milliseconds since the epoch. */
  readonly at: number;
}

export const findJumpAtom = Atom.make<FindJump | undefined>(undefined);

/** Lower case, letter for letter, so a place found in the folded text is the same place in the original. */
const foldCase = (text: string): string => {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  return text.replace(/./gsu, (char) =>
    char.toLowerCase().length === char.length ? char.toLowerCase() : char,
  );
};

/** The passage's text, cut where the search cut it: the "…" that marks an end is left out. */
export const passageTexts = (passage: ReadonlyArray<Piece>): ReadonlyArray<string> =>
  passage
    .map((piece) => piece.text)
    .join("")
    .split("…")
    .map((part) => part.trim())
    .filter((part) => part !== "");

/** The distinct words the search matched, which the passage marks. */
export const matchedWords = (passage: ReadonlyArray<Piece>): ReadonlyArray<string> => [
  ...new Set(passage.filter((piece) => piece.match).map((piece) => piece.text)),
];

/**
 * The messages a jump might mean, best first: the newest holding the passage's text, then the newest
 * holding each of its matched words. Only the ids come back: the window checks which are on screen.
 */
export const jumpCandidates = (
  messages: ReadonlyArray<{ readonly id: string; readonly text: string }>,
  passage: ReadonlyArray<Piece>,
): ReadonlyArray<string> => {
  const parts = passageTexts(passage);
  const words = matchedWords(passage).map(foldCase);
  const newest = [...messages].reverse();
  const holding = newest.filter(({ text }) => parts.length > 0 && parts.every((part) => text.includes(part)));
  const sharing = newest.filter(
    (message) =>
      words.length > 0 &&
      !holding.includes(message) &&
      words.every((word) => foldCase(message.text).includes(word)),
  );
  return [...holding, ...sharing].map(({ id }) => id);
};

/** What the transcript's messages are found in: the ones marked `data-find`, never the chrome around them. */
const SKIPPED = "button, select, textarea, svg";

/** The text node a position of the joined text falls in, and where that node's text starts. */
const partAt = (parts: ReadonlyArray<{ readonly node: Text; readonly start: number }>, position: number) => {
  let low = 0;
  let high = parts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (parts[middle]!.start <= position) low = middle;
    else high = middle - 1;
  }
  return parts[low]!;
};

/** Each place under `root` where one of `needles` reads, ignoring case, as a range over its text. */
const rangesIn = (root: Element, needles: ReadonlyArray<string>): Array<Range> => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(SKIPPED) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const parts: Array<{ readonly node: Text; readonly start: number }> = [];
  let text = "";
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    parts.push({ node: node as Text, start: text.length });
    text += (node as Text).data;
  }
  const folded = foldCase(text);
  const spans: Array<readonly [number, number]> = [];
  for (const needle of needles.map(foldCase)) {
    if (needle === "") continue;
    for (let at = folded.indexOf(needle); at !== -1; at = folded.indexOf(needle, at + needle.length)) {
      spans.push([at, at + needle.length]);
    }
  }
  return spans
    .toSorted((a, b) => a[0] - b[0])
    .map(([start, end]) => {
      const first = partAt(parts, start);
      const last = partAt(parts, end - 1);
      const range = document.createRange();
      range.setStart(first.node, start - first.start);
      range.setEnd(last.node, end - last.start);
      return range;
    });
};

/** Every place in the conversation under `scope` where `query` reads, in order, ignoring case. */
export const findRanges = (scope: Element, query: string): Array<Range> =>
  [...scope.querySelectorAll("[data-find]")].flatMap((message) => rangesIn(message, [query]));

/** The places in one message where any of `words` reads. */
export const wordRanges = (message: Element, words: ReadonlyArray<string>): Array<Range> =>
  rangesIn(message, words);

/** A range over everything in `element`. */
export const rangeOf = (element: Element): Range => {
  const range = document.createRange();
  range.selectNodeContents(element);
  return range;
};

/**
 * Brings `range` to the middle of the thread: a fold it sits in opens first, and the thread stops
 * following its end, as it does when the artifacts panel brings something into view.
 */
export const showRange = (range: Range, smooth: boolean): void => {
  const at =
    range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  if (!at) return;
  at.dispatchEvent(new Event(UNFOLD_EVENT, { bubbles: true }));
  at.dispatchEvent(new Event(REVEAL_EVENT, { bubbles: true }));
  const glide = smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  // scrollIntoView also scrolls overflow:hidden disclosures. When their height animation ends,
  // that inner scroll is clamped back to zero and the match disappears again. Move actual scroll
  // viewports explicitly, from the innermost (a code block) to the conversation around it.
  let scrolled = false;
  for (let parent = at.parentElement; parent !== null; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowY;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    const target = range.getBoundingClientRect();
    const viewport = parent.getBoundingClientRect();
    parent.scrollBy({
      top: target.top - viewport.top - Math.max(0, (viewport.height - target.height) / 2),
      behavior: glide ? "smooth" : "instant",
    });
    scrolled = true;
  }
  if (!scrolled) at.scrollIntoView({ block: "center", behavior: glide ? "smooth" : "auto" });
};

/** Rings a message for a moment, as the artifacts panel rings an artifact it brings into view. */
export const ringMessage = (message: HTMLElement): void => {
  message.removeAttribute("data-found");
  // Restarts the ring when the same message is brought in again.
  void message.offsetWidth;
  message.setAttribute("data-found", "");
  window.setTimeout(() => message.removeAttribute("data-found"), RING_MS);
};

/** Marks `ranges` for a moment, under the name `CSS.highlights` knows them by, then lets them go. */
export const markFor = (name: string, ranges: ReadonlyArray<Range>): void => {
  CSS.highlights.set(name, new Highlight(...ranges));
  window.setTimeout(() => CSS.highlights.delete(name), MARK_MS);
};
