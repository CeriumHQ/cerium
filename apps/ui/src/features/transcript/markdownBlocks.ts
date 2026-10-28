import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

// How agent markdown is cut into the blocks the transcript renders one by one, and how a block still
// being written is closed off so it reads right before its closing marks arrive. Plain functions, so
// the tests and the renderer share them.

const parser = unified().use(remarkParse).use(remarkGfm);

/** Where each top-level block of `text` starts. */
const blockStarts = (text: string, from = 0): Array<number> => {
  const tree = parser.parse(text.slice(from));
  const starts = tree.children.flatMap((node) => {
    const offset = node.position?.start.offset;
    return offset === undefined ? [] : [offset + from];
  });
  // Text before the first block (blank lines) belongs to it.
  if (starts.length > 0) starts[0] = from;
  return starts.length > 0 ? starts : [from];
};

/** The texts already split, by the text, for a reply that grows: its earlier blocks stay as they were. */
const splits = new Map<string, ReadonlyArray<number>>();
const KEPT = 24;

/**
 * `text` as its top-level blocks, each with the blank lines after it. A text that grew from one
 * split before is parsed again only from its last block on, which is the only one the new words can
 * change: a reply streaming in costs the length of its last block, not of the whole reply.
 */
export const splitBlocks = (text: string): ReadonlyArray<string> => {
  let starts = splits.get(text);
  if (starts === undefined) {
    let grown: { readonly text: string; readonly starts: ReadonlyArray<number> } | undefined;
    for (const [earlier, earlierStarts] of splits) {
      if (text.startsWith(earlier) && (grown === undefined || earlier.length > grown.text.length)) {
        grown = { text: earlier, starts: earlierStarts };
      }
    }
    const from = grown?.starts.at(-1) ?? 0;
    starts = [...(grown?.starts.slice(0, -1) ?? []), ...blockStarts(text, from)];
    splits.set(text, starts);
    if (splits.size > KEPT) splits.delete(splits.keys().next().value!);
  }
  return starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length));
};

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Whether `block` opens a fenced code block it doesn't close yet. */
export const openFence = (block: string): boolean => {
  let open: string | undefined;
  for (const line of block.split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (marker === undefined) continue;
    if (open === undefined) open = marker;
    else if (marker[0] === open[0] && marker.length >= open.length && line.trim() === marker) {
      open = undefined;
    }
  }
  return open !== undefined;
};

/** The inline marks that pair up, longest first so `**` is read before `*`. */
const MARKS = ["~~", "**", "__", "*", "_"] as const;

/**
 * The last line of a block that's still being written, with the inline marks it opened closed and a
 * link whose address hasn't arrived shown as its text, so bold doesn't flash in as asterisks and a
 * half-written link as brackets.
 */
const closeLine = (line: string): string => {
  const open: Array<string> = [];
  let code = false;
  let index = 0;
  while (index < line.length) {
    const char = line[index]!;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "`") {
      code = !code;
      index++;
      continue;
    }
    if (code) {
      index++;
      continue;
    }
    const mark = MARKS.find((each) => line.startsWith(each, index));
    if (mark === undefined) {
      index++;
      continue;
    }
    // `_` inside a word (snake_case) and a `*` list marker or spaced asterisk aren't emphasis.
    const before = line[index - 1];
    const after = line[index + mark.length];
    const intraword = mark[0] === "_" && before !== undefined && /\w/.test(before);
    const spaced = after === undefined || after === " ";
    if (open.at(-1) === mark) open.pop();
    else if (!intraword && !spaced) open.push(mark);
    index += mark.length;
  }
  let closed = line;
  // An image or link still being written: `[text](add` or `[text` reads as its text so far.
  closed = closed.replace(/!?\[([^\]]*)\]\([^)]*$/, "$1").replace(/!?\[([^\]]*)$/, "$1");
  if (code) closed += "`";
  return closed + open.toReversed().join("");
};

/**
 * A block still being written, made to render as it will once it's whole: its last line's inline
 * marks closed, and a heading or setext underline with nothing to it yet left out. An open code
 * fence renders to the block's end as it is.
 */
export const closeOpenSyntax = (block: string): string => {
  if (openFence(block)) return block;
  const body = block.replace(/\s+$/, "");
  const cut = body.lastIndexOf("\n");
  const head = body.slice(0, cut + 1);
  const last = body.slice(cut + 1);
  // `#` alone is a heading with no words yet; `-` or `=` under a paragraph would turn it into one.
  if (/^ {0,3}(#{1,6}|[-=]{1,2})$/.test(last)) return head.replace(/\n$/, "");
  return head + closeLine(last);
};
