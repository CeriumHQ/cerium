import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

// How agent markdown is cut into the blocks the transcript renders one by one, and how a block still
// being written is closed off so it reads right before its closing marks arrive. Plain functions, so
// the tests and the renderer share them.

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

interface ClosingLine {
  readonly indent: number;
  readonly marks: number;
  readonly trailing: boolean;
}

interface FenceTail {
  readonly marker: string;
  readonly body: number;
  readonly language: string;
  readonly indent: number;
  /** Only a possible closing line is retained; a long code line costs no more on the next append. */
  readonly line: ClosingLine | undefined;
}

interface Split {
  readonly starts: ReadonlyArray<number>;
  readonly fence?: FenceTail;
}

const closing = (line: ClosingLine | undefined, marker: string): boolean =>
  line !== undefined && line.marks >= marker.length;

/** Scans appended characters once, including a closing marker arriving across several batches. */
const advanceFence = (text: string, from: number, fence: FenceTail) => {
  let line = fence.line;
  for (let index = from; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\n") {
      if (closing(line, fence.marker)) return { end: index + 1 };
      line = { indent: 0, marks: 0, trailing: false };
    } else if (line !== undefined) {
      if (char === fence.marker[0] && !line.trailing) line = { ...line, marks: line.marks + 1 };
      else if (char === " " && line.marks === 0 && line.indent < 3)
        line = { ...line, indent: line.indent + 1 };
      else if ((char === " " || char === "\t" || char === "\r") && line.marks > 0)
        line = { ...line, trailing: true };
      else line = undefined;
    }
  }
  return { fence: { ...fence, line } };
};

/** Where each top-level block starts, and whether the last one is a fence we can extend directly. */
const blockStarts = (text: string, from = 0, keepLeading = true): Split => {
  const tree = parser.parse(text.slice(from));
  const starts = tree.children.flatMap((node) => {
    const offset = node.position?.start.offset;
    return offset === undefined ? [] : [offset + from];
  });
  // Text before the first block (blank lines) belongs to it.
  if (starts.length > 0 && keepLeading) starts[0] = from;
  const last = tree.children.at(-1);
  const offset = last?.position?.start.offset;
  if ((last?.type === "code" || last?.type === "math") && offset !== undefined) {
    const start = offset + from;
    const end = text.indexOf("\n", start);
    const opening = /^ {0,3}(`{3,}|~{3,}|\${2,})([^\n]*)$/.exec(text.slice(start, end));
    if (end !== -1 && opening !== null) {
      const tail = advanceFence(text, end + 1, {
        marker: opening[1]!,
        body: end + 1,
        language: last.type === "math" ? "math" : (last.lang?.toLowerCase() ?? ""),
        indent: start - (text.lastIndexOf("\n", start - 1) + 1),
        line: { indent: 0, marks: 0, trailing: false },
      });
      if (tail.fence !== undefined) return { starts, fence: tail.fence };
    }
  }
  return { starts: starts.length > 0 ? starts : keepLeading ? [from] : [] };
};

/** The texts already split, by the text, for a reply that grows: its earlier blocks stay as they were. */
const splits = new Map<string, Split>();
const fences = new Map<string, FenceTail>();
const KEPT = 24;
let recent: { readonly text: string; readonly split: Split } | undefined;

/**
 * `text` as its top-level blocks, each with the blank lines after it. A text that grew from one
 * split before is parsed again only from its last block on, which is the only one the new words can
 * change: a reply streaming in costs the length of its last block, not of the whole reply.
 */
export const splitBlocks = (text: string): ReadonlyArray<string> => {
  let grown = recent !== undefined && text.startsWith(recent.text) ? recent : undefined;
  let split = recent?.text === text ? recent.split : grown === undefined ? splits.get(text) : undefined;
  if (split === undefined) {
    if (grown === undefined) {
      for (const [earlier, earlierSplit] of splits) {
        if (text.startsWith(earlier) && (grown === undefined || earlier.length > grown.text.length)) {
          grown = { text: earlier, split: earlierSplit };
        }
      }
    }
    if (grown?.split.fence !== undefined) {
      const tail = advanceFence(text, grown.text.length, grown.split.fence);
      if (tail.fence !== undefined) split = { starts: grown.split.starts, fence: tail.fence };
      else {
        const after = blockStarts(text, tail.end, false);
        split = { ...after, starts: [...grown.split.starts, ...after.starts] };
      }
    } else {
      const from = grown?.split.starts.at(-1) ?? 0;
      const after = blockStarts(text, from);
      split = { ...after, starts: [...(grown?.split.starts.slice(0, -1) ?? []), ...after.starts] };
    }
    splits.set(text, split);
    if (splits.size > KEPT) splits.delete(splits.keys().next().value!);
  }
  recent = { text, split };
  return split.starts.map((start, index) => {
    const block = text.slice(start, split.starts[index + 1] ?? text.length);
    if (index === split.starts.length - 1 && split.fence !== undefined) {
      fences.set(block, { ...split.fence, body: split.fence.body - start });
      if (fences.size > KEPT) fences.delete(fences.keys().next().value!);
    }
    return block;
  });
};

/** An unfinished top-level fence, without sending its growing body through Markdown again. */
export const streamingFence = (
  block: string,
):
  | { readonly text: string; readonly language: string; readonly indent: number; readonly raw: true }
  | undefined => {
  const fence = fences.get(block);
  return fence === undefined || closing(fence.line, fence.marker)
    ? undefined
    : {
        text: block.slice(fence.body).replace(/\r?\n$/, ""),
        language: fence.language,
        indent: fence.indent,
        raw: true,
      };
};

/** CommonMark removes up to the opening fence's indentation and normalizes line endings. */
export const fenceText = (text: string, indent: number): string =>
  text.replace(/\r\n?/g, "\n").replace(new RegExp(`^ {0,${indent}}`, "gm"), "");

/** A bounded preview even for a fence containing one enormous line. Copy still uses the full text. */
export const codePreview = (text: string): string => {
  const prefix = text.slice(0, 16_384);
  let end = 0;
  for (let line = 0; line < 20; line++) {
    const next = prefix.indexOf("\n", end);
    if (next === -1) return prefix;
    if (line === 19) return prefix.slice(0, next);
    end = next + 1;
  }
  return prefix;
};

const FENCE = /^ {0,3}(`{3,}|~{3,}|\${2,})/;

/** Whether `block` opens a fenced code block, or a `$$` math block, it doesn't close yet. */
export const openFence = (block: string): boolean => {
  const known = fences.get(block);
  if (known !== undefined) return !closing(known.line, known.marker);
  let open: string | undefined;
  for (const line of block.split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (marker === undefined) continue;
    // `$$ x = 1 $$` on one line is whole.
    const trimmed = line.trim();
    if (
      open === undefined &&
      marker[0] === "$" &&
      trimmed.length > 2 * marker.length &&
      trimmed.endsWith(marker)
    ) {
      continue;
    }
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
