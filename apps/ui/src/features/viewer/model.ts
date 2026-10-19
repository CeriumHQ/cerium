import type { DiffHunk, DiffLine, FilePreview, FileState } from "@cerium/rpc";
import { Atom } from "effect/reactivity";

import { stored } from "../../lib/storage.ts";
import type { Line, Token } from "./highlight.ts";

// What the file viewer shows of a work thread's file, as plain functions: the tab that holds it, the
// ways to look at it, and its diff laid out in rows with the words that changed picked out.

/** The `RPC_VERSION` that brought the viewer's calls; an older machine's files open nowhere. */
export const VIEWER_VERSION = 6;

// ---------------------------------------------------------------------------------------------
// Tabs

const FILE_PREFIX = "file:";

/** The tab key of the file at `path` in the folder `root`. */
export const fileKey = (root: string, path: string) => `${FILE_PREFIX}${root}\n${path}`;

export interface FileTab {
  /** The thread's folder. */
  readonly root: string;
  /** The file, relative to `root`. */
  readonly path: string;
}

/** The file a tab key names; undefined for a thread's key. */
export const fileOfKey = (key: string | undefined): FileTab | undefined => {
  if (key?.startsWith(FILE_PREFIX) !== true) return undefined;
  const split = key.indexOf("\n");
  if (split === -1) return undefined;
  const root = key.slice(FILE_PREFIX.length, split);
  const path = key.slice(split + 1);
  return root === "" || path === "" ? undefined : { root, path };
};

export const isFileKey = (key: string | undefined) => fileOfKey(key) !== undefined;

// ---------------------------------------------------------------------------------------------
// Views

/** How a file can be looked at: its changes, its text, or (Markdown, HTML, SVG) as it renders. */
export type FileView = "diff" | "file" | "rendered";

/**
 * The view a file's tab shows, by its key, while the window is open: wherever the tab is shown (a
 * pane, the main area), it shows the same. Opening a file from the explorer's Changes sets "diff".
 */
export const fileViewAtom = Atom.family((_key: string) =>
  Atom.make<FileView | undefined>(undefined).pipe(Atom.keepAlive),
);

/** A file's diff shows every unchanged line, not just those around its changes; by tab key. */
export const wholeDiffAtom = Atom.family((_key: string) => Atom.make(false).pipe(Atom.keepAlive));

export const DIFF_LAYOUT_KEY = "cerium:diffLayout";
export const WRAP_KEY = "cerium:wrapLines";

/** Diffs one column or side by side, as the user last chose; remembered across launches. */
export const diffLayoutAtom = Atom.make<"unified" | "split">(
  stored(DIFF_LAYOUT_KEY) === "split" ? "split" : "unified",
).pipe(Atom.keepAlive);

/** Long lines fold to the viewer's width, as the user last chose. */
export const wrapAtom = Atom.make(stored(WRAP_KEY) === "on").pipe(Atom.keepAlive);

/** Text the viewer can also show as it renders. */
export type Rendered = "markdown" | "html" | "svg";

export const renderedKind = (path: string): Rendered | undefined => {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "md" || extension === "mdx" || extension === "markdown") return "markdown";
  if (extension === "html" || extension === "htm" || extension === "xhtml") return "html";
  if (extension === "svg") return "svg";
  return undefined;
};

/** Git has something to compare the file with: it changed since the last commit. */
export const hasDiff = (state: FileState | undefined) => state !== undefined;

/** The views a file offers, in the order the switch lists them. */
export const viewsOf = (
  path: string,
  state: FileState | undefined,
  preview: FilePreview["_tag"] | undefined,
): ReadonlyArray<{ readonly value: FileView; readonly label: string }> => {
  const rendered = renderedKind(path);
  const text = preview === undefined || preview === "Text";
  return [
    ...(hasDiff(state) ? [{ value: "diff" as const, label: "Changes" }] : []),
    ...(state === "deleted"
      ? []
      : rendered !== undefined && text
        ? [
            { value: "rendered" as const, label: "Preview" },
            { value: "file" as const, label: "Source" },
          ]
        : [{ value: "file" as const, label: "File" }]),
  ];
};

/**
 * The view to show: the one chosen if the file still offers it, else what it was opened for, else
 * its first. A file that renders opens rendered rather than as source.
 */
export const pickView = (
  views: ReadonlyArray<{ readonly value: FileView }>,
  chosen: FileView | undefined,
): FileView => {
  if (chosen !== undefined && views.some((view) => view.value === chosen)) return chosen;
  return (
    views.find((view) => view.value === "rendered")?.value ??
    views.find((view) => view.value === "file")?.value ??
    views[0]?.value ??
    "file"
  );
};

export const byteSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
};

// ---------------------------------------------------------------------------------------------
// Diffs

/** A line of a diff with where it is on each side; a removed line has no new number, an added no old. */
export interface NumberedLine extends DiffLine {
  readonly old?: number;
  readonly new?: number;
  /** Its place among the old side's lines, then the new side's, in `sideTexts`. */
  readonly oldIndex?: number;
  readonly newIndex?: number;
}

export interface NumberedHunk {
  readonly lines: ReadonlyArray<NumberedLine>;
  /** Unchanged lines between this hunk and the one before it (or the file's start). */
  readonly gapBefore: number;
}

/**
 * The hunks with each line's numbers, the unchanged stretch before each, and both sides' text as
 * one string each (for highlighting the hunks as a whole, so a comment that spans lines reads right).
 */
export const numberHunks = (
  hunks: ReadonlyArray<DiffHunk>,
): {
  readonly hunks: ReadonlyArray<NumberedHunk>;
  readonly oldText: string;
  readonly newText: string;
} => {
  const oldLines: Array<string> = [];
  const newLines: Array<string> = [];
  let previousEnd = 1;
  const numbered = hunks.map((hunk): NumberedHunk => {
    // A hunk of a new file starts at 0 on the old side: nothing comes before it.
    const oldStart = Math.max(hunk.oldStart, 1);
    const gapBefore = hunk.oldStart === 0 ? 0 : Math.max(0, oldStart - previousEnd);
    let old = oldStart;
    let next = hunk.newStart;
    const lines = hunk.lines.map((line): NumberedLine => {
      if (line.kind === "added") {
        newLines.push(line.text);
        return { ...line, new: next++, newIndex: newLines.length - 1 };
      }
      if (line.kind === "removed") {
        oldLines.push(line.text);
        return { ...line, old: old++, oldIndex: oldLines.length - 1 };
      }
      oldLines.push(line.text);
      newLines.push(line.text);
      return {
        ...line,
        old: old++,
        new: next++,
        oldIndex: oldLines.length - 1,
        newIndex: newLines.length - 1,
      };
    });
    previousEnd = old;
    return { lines, gapBefore };
  });
  return { hunks: numbered, oldText: oldLines.join("\n"), newText: newLines.join("\n") };
};

export const diffStats = (hunks: ReadonlyArray<DiffHunk>) => {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "added") added++;
      else if (line.kind === "removed") removed++;
    }
  }
  return { added, removed };
};

/** A row of the side-by-side diff: the old line on the left, the new on the right, either missing. */
export interface SplitRow {
  readonly left?: NumberedLine;
  readonly right?: NumberedLine;
}

/** A hunk's lines side by side: unchanged lines on both sides, a run of removals beside the additions after it. */
export const splitRows = (lines: ReadonlyArray<NumberedLine>): ReadonlyArray<SplitRow> => {
  const rows: Array<SplitRow> = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      index++;
      continue;
    }
    const removed: Array<NumberedLine> = [];
    const added: Array<NumberedLine> = [];
    while (index < lines.length && lines[index]!.kind === "removed") removed.push(lines[index++]!);
    while (index < lines.length && lines[index]!.kind === "added") added.push(lines[index++]!);
    for (let row = 0; row < Math.max(removed.length, added.length); row++) {
      const left = removed[row];
      const right = added[row];
      rows.push({ ...(left ? { left } : {}), ...(right ? { right } : {}) });
    }
  }
  return rows;
};

/**
 * Pairs each removed line with the added line that replaced it, in runs of removals followed by
 * additions, as `splitRows` places them side by side; by index in `lines`.
 */
export const replacedPairs = (lines: ReadonlyArray<DiffLine>): ReadonlyMap<number, number> => {
  const pairs = new Map<number, number>();
  let index = 0;
  while (index < lines.length) {
    if (lines[index]!.kind !== "removed") {
      index++;
      continue;
    }
    const removedStart = index;
    while (index < lines.length && lines[index]!.kind === "removed") index++;
    const addedStart = index;
    while (index < lines.length && lines[index]!.kind === "added") index++;
    const count = Math.min(addedStart - removedStart, index - addedStart);
    for (let offset = 0; offset < count; offset++) {
      pairs.set(removedStart + offset, addedStart + offset);
      pairs.set(addedStart + offset, removedStart + offset);
    }
  }
  return pairs;
};

/** A stretch of a line, `[start, end)` in characters. */
export type Range = readonly [start: number, end: number];

const WORDS = /\w+|\s+|[^\w\s]/g;
/** Past this many words a side, the whole line counts as changed: the table would be too large. */
const MAX_WORDS = 400;

/**
 * What changed between a line and the one that replaced it, word by word: the stretches of `before`
 * that went and of `after` that came. None when the lines share too little for it to help.
 */
export const changedWords = (
  before: string,
  after: string,
): { readonly removed: ReadonlyArray<Range>; readonly added: ReadonlyArray<Range> } | undefined => {
  const a = before.match(WORDS) ?? [];
  const b = after.match(WORDS) ?? [];
  if (a.length > MAX_WORDS || b.length > MAX_WORDS) return undefined;
  // The longest common subsequence of words, read back from its table.
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const keptA = new Array<boolean>(a.length).fill(false);
  const keptB = new Array<boolean>(b.length).fill(false);
  let shared = 0;
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) {
      keptA[i++] = true;
      keptB[j++] = true;
      shared++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i++;
    else j++;
  }
  const sharedChars = a
    .filter((_, index) => keptA[index])
    .join("")
    .trim().length;
  // Lines that only share spaces and punctuation were rewritten, not edited.
  if (shared === 0 || sharedChars < Math.min(before.trim().length, after.trim().length) / 3) return undefined;
  const ranges = (words: ReadonlyArray<string>, kept: ReadonlyArray<boolean>) => {
    const found: Array<[number, number]> = [];
    let at = 0;
    words.forEach((word, index) => {
      if (!kept[index]) {
        const last = found.at(-1);
        if (last !== undefined && last[1] === at) last[1] = at + word.length;
        else found.push([at, at + word.length]);
      }
      at += word.length;
    });
    return found;
  };
  return { removed: ranges(a, keptA), added: ranges(b, keptB) };
};

/** A run of a line as drawn: its token's colour and style, and whether it's among the changed words. */
export interface Piece {
  readonly text: string;
  readonly color?: string;
  readonly italic?: boolean;
  readonly marked: boolean;
}

/** `text` as pieces: its highlighted tokens (or the plain text), cut where the changed `ranges` start and end. */
export const pieces = (
  text: string,
  tokens: Line | undefined,
  ranges: ReadonlyArray<Range>,
): ReadonlyArray<Piece> => {
  const runs: ReadonlyArray<Token> = tokens ?? [[text]];
  const result: Array<Piece> = [];
  let at = 0;
  for (const [content, color, italic] of runs) {
    let start = 0;
    while (start < content.length) {
      const position = at + start;
      const inside = ranges.find(([from, to]) => position >= from && position < to);
      const nextEdge = inside
        ? inside[1]
        : Math.min(...ranges.filter(([from]) => from > position).map(([from]) => from), Infinity);
      const end = Math.min(content.length, nextEdge - at);
      result.push({
        text: content.slice(start, end),
        ...(color === undefined ? {} : { color }),
        ...(italic === 1 ? { italic: true } : {}),
        marked: inside !== undefined,
      });
      start = end;
    }
    at += content.length;
  }
  return result;
};
