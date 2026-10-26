import type { DiffHunk } from "@cerium/rpc";
import { Button } from "@base-ui/react/button";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

import type { DraftCommentFile } from "../composer/draft.ts";
import { lineRange } from "../composer/draft.ts";
import { CHUNK, LINE_HEIGHT, Run } from "./CodeView.tsx";
import { VisibleChunk } from "./VisibleChunk.tsx";
import { useHighlight } from "./highlight.ts";
import {
  changedWords,
  numberHunks,
  pieces,
  replacedPairs,
  splitRows,
  type NumberedLine,
  type Range,
} from "./model.ts";

export type DiffLayout = "unified" | "split";

const marker = { context: " ", removed: "−", added: "+" } as const;
const tint = {
  context: "",
  removed: "bg-error/10",
  added: "bg-success/10",
} as const;
const markerTint = { context: "text-fg-disabled", removed: "text-error", added: "text-success" } as const;
/** The words that changed within a changed line, a step stronger than the line's own tint. */
const wordMark = { context: "", removed: "rounded-[2px] bg-error/25", added: "rounded-[2px] bg-success/25" };

const number = "shrink-0 px-2 text-right text-fg-disabled tabular-nums select-none";

/** Picking a diff's changed lines, to stage, unstage or discard only those. */
export interface DiffPicking {
  /** The line at `line` of hunk `hunk` is picked. */
  readonly picked: (hunk: number, line: number) => boolean;
  /** Picks a changed line or unpicks it; `extend` picks every changed line from the last one picked. */
  readonly onPick: (hunk: number, line: number, extend: boolean) => void;
  /** What acts on a hunk as a whole, on the bar above it; nothing leaves the hunk without a bar of its own. */
  readonly hunkActions: (hunk: number) => ReactNode;
}

/**
 * The unchanged lines a diff leaves out between two hunks, with a way to show the whole file; while
 * lines are picked, the bar above each hunk, with what acts on it.
 */
function Gap({
  lines,
  onExpand,
  children,
}: {
  lines: number;
  onExpand: (() => void) | undefined;
  children?: ReactNode;
}) {
  const label = lines === 1 ? "1 unchanged line" : `${lines.toLocaleString()} unchanged lines`;
  // A hunk that folds nothing away keeps only its actions, on a bar of its own that draws no band.
  const band = lines === 0 ? "" : "border-y border-line-subtle bg-surface-hover";
  return (
    <div
      className={`flex items-center text-meta text-fg-tertiary select-none ${band} ${children === undefined ? "h-7" : "h-8 pr-1.5"}`}
    >
      {lines === 0 ? null : onExpand ? (
        <button
          type="button"
          onClick={onExpand}
          className="flex h-full items-center gap-1.5 px-3 font-sans transition-colors hover:text-fg-primary"
        >
          <ChevronsUpDown size={12} strokeWidth={2} />
          {label}
        </button>
      ) : (
        <span className="px-3 font-sans">{label}</span>
      )}
      {children === undefined ? null : (
        <span className="ml-auto flex items-center gap-1 font-sans">{children}</span>
      )}
    </div>
  );
}

/** The box beside a changed line that picks it. */
function Pick({ picked, onPick }: { picked: boolean; onPick: (extend: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={picked}
      aria-label={picked ? "Unpick line" : "Pick line"}
      // Shift extends the pick; the browser would select text instead.
      onMouseDown={(event) => {
        if (event.shiftKey) event.preventDefault();
      }}
      onClick={(event) => onPick(event.shiftKey)}
      className="grid w-6 shrink-0 cursor-default place-items-center self-stretch outline-none select-none focus-visible:ring-1 focus-visible:ring-focus-ring focus-visible:ring-inset"
    >
      <span
        className={`grid size-3 place-items-center rounded-[3px] border transition-[opacity,background-color,border-color] duration-100 ${picked ? "border-accent bg-accent text-accent-fg" : "border-line-strong opacity-40 group-hover/line:opacity-100"}`}
      >
        {picked ? <Check size={9} strokeWidth={3.5} /> : null}
      </span>
    </button>
  );
}

/** Where a context line's box would be, so the columns line up. */
const NoPick = () => <span className="w-6 shrink-0" aria-hidden="true" />;

/** A picked line's mark down its left edge. */
const pickedEdge = "shadow-[inset_2px_0_0_var(--color-accent)]";

/** A line marked for a comment run, by its hunk's index and its own within the hunk. */
const runId = (hunk: number, line: number) => `${hunk}:${line}`;

const runAt = (id: string): readonly [number, number] => {
  const split = id.indexOf(":");
  return [Number(id.slice(0, split)), Number(id.slice(split + 1))];
};

/** `ids`, first to last as the diff shows them. */
const orderedId = (a: string, b: string) => {
  const [hunkA, lineA] = runAt(a);
  const [hunkB, lineB] = runAt(b);
  return hunkA - hunkB || lineA - lineB;
};

/** The lines of the diff that show, from `from` to `to`, whichever comes first, both included; the stretch folded between hunks isn't. */
const linesBetween = (hunks: ReadonlyArray<DiffHunk>, from: string, to: string): ReadonlyArray<string> => {
  const shown = hunks.flatMap((hunk, at) => hunk.lines.map((_, index) => runId(at, index)));
  const start = shown.indexOf(from);
  const end = shown.indexOf(to);
  return start === -1 || end === -1 ? [to] : shown.slice(Math.min(start, end), Math.max(start, end) + 1);
};

/**
 * What a diff carries to comment on its lines: the numbers that a comment waiting in the draft
 * covers, and where the run the user picks goes when it's added.
 */
export interface DiffCommenting {
  /** Line numbers that a comment waiting in the draft covers, at the number each line anchors. */
  readonly marked: ReadonlySet<number>;
  /** What hangs under a line besides the run's box: a review's findings whose last line it is. */
  readonly under?: ((line: NumberedLine) => ReactNode) | undefined;
  /** Adds the run's comment, with the file, its lines and the remark under them. */
  readonly onAdd: (comment: {
    readonly quote: string;
    readonly file: DraftCommentFile;
    readonly text: string;
  }) => void;
}

/** The box beside a line that comments on it, or marks a run already picked. */
function CommentPlus({ picked, onPick }: { picked: boolean; onPick: (extend: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={picked}
      aria-label={picked ? "Commenting on this line" : "Comment on line"}
      // Shift extends the run; the browser would select text instead.
      onMouseDown={(event) => {
        if (event.shiftKey) event.preventDefault();
      }}
      onClick={(event) => onPick(event.shiftKey)}
      className={`grid w-5 shrink-0 cursor-default place-items-center self-stretch text-fg-tertiary outline-none select-none transition-opacity duration-100 focus-visible:opacity-100 ${
        picked ? "opacity-100" : "opacity-0 group-hover/line:opacity-100"
      }`}
    >
      <span className={`grid size-3.5 place-items-center rounded-[3px] ${picked ? "text-accent" : ""}`}>
        <Plus size={12} strokeWidth={2.25} />
      </span>
    </button>
  );
}

/** The box under a comment's run, where the remark is written; Enter adds, like the passage's does. */
function CommentBox({
  onAdd,
  onClose,
  range,
  lines,
}: {
  onAdd: (text: string) => void;
  onClose: () => void;
  /** The lines the comment covers, as the tray will name them. */
  range: string;
  /** How many of them there are. */
  lines: number;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  useEffect(() => field.current?.focus(), []);
  return (
    <div className="flex flex-col gap-1.5 border-y border-line-subtle bg-surface-window px-2.5 py-2">
      <div className="flex items-baseline gap-2 font-mono text-meta text-fg-tertiary tabular-nums">
        <span className="min-w-0 truncate">{range}</span>
        <span className="shrink-0 font-sans">{lines === 1 ? "1 line" : `${lines} lines`}</span>
      </div>
      <textarea
        ref={field}
        aria-label="Comment"
        value={text}
        rows={2}
        placeholder="What about these lines?"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onAdd(text);
          }
        }}
        className="block max-h-40 min-h-12 w-full resize-none rounded-lg border border-line-subtle bg-surface-raised px-2.5 py-2 text-body outline-none [field-sizing:content] placeholder:text-fg-disabled focus:border-line-strong"
      />
      <div className="flex items-center justify-end gap-1">
        <Button
          onClick={onClose}
          className="h-7 rounded-md px-2.5 text-meta text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg-primary"
        >
          Cancel
        </Button>
        <Button
          onClick={() => onAdd(text)}
          disabled={text.trim() === ""}
          className="h-7 rounded-md bg-accent px-2.5 text-meta font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Add comment
        </Button>
      </div>
    </div>
  );
}

/**
 * A hunk's rows in chunks the browser lays out and paints only near the view, each with where it
 * starts. Unwrapped, as one column scrolling sideways draws them, a row is one line high, so a chunk
 * out of view takes the height it will have; a side by side diff's rows can wrap and grow once drawn.
 */
function chunksOf<Row>(rows: ReadonlyArray<Row>) {
  return Array.from({ length: Math.ceil(rows.length / CHUNK) }, (_, index) => ({
    first: index * CHUNK,
    rows: rows.slice(index * CHUNK, (index + 1) * CHUNK),
  }));
}

/** The words each changed line lost or gained against the line it replaced, by index in the hunk. */
const rangesOf = (lines: ReadonlyArray<NumberedLine>, budget: { left: number }) => {
  const pairs = replacedPairs(lines);
  const ranges = new Map<number, ReadonlyArray<Range>>();
  for (const [index, other] of pairs) {
    const line = lines[index]!;
    if (line.kind !== "removed") continue;
    // Bound the whole diff's work, not just one line. Characters upper-bound token count.
    const cost = line.text.length * lines[other]!.text.length;
    if (cost > budget.left) continue;
    budget.left -= cost;
    const words = changedWords(line.text, lines[other]!.text);
    if (words === undefined) continue;
    ranges.set(index, words.removed);
    ranges.set(other, words.added);
  }
  return ranges;
};

/**
 * The hunks numbered, the words that changed in each hunk's lines, and each side highlighted. A hook
 * of its own so the React Compiler keeps them from one render to the next: worked out in the
 * component, which reads them after the highlighting hooks, they were worked out again on every
 * render, word-by-word comparisons and all.
 */
function useNumbered(hunks: ReadonlyArray<DiffHunk>, path: string) {
  const numbered = numberHunks(hunks);
  const budget = { left: 2_000_000 };
  const ranges = numbered.hunks.map((hunk) => rangesOf(hunk.lines, budget));
  const oldTokens = useHighlight(numbered.oldText, path);
  const newTokens = useHighlight(numbered.newText, path);
  return { hunks: numbered.hunks, ranges, oldTokens, newTokens };
}

/** One side's line: its number, its marker, and its text with the changed words picked out. */
function Cell({
  line,
  number: lineNumber,
  ranges,
  tokens,
  gutter,
  wrap = false,
  mark,
  pick,
}: {
  line: NumberedLine | undefined;
  number: number | undefined;
  ranges: ReadonlyArray<Range>;
  tokens: Parameters<typeof pieces>[1];
  gutter: string;
  /** Long lines wrap rather than run past the side's edge, as each side of a split diff does. */
  wrap?: boolean;
  /** The box that comments on the line, before its pick on a side of a split diff. */
  mark?: ReactNode;
  /** The box that picks the line, on a side of a split diff. */
  pick?: ReactNode;
}) {
  if (line === undefined) {
    return <div className="min-w-0 flex-1 bg-surface-hover/60" aria-hidden="true" />;
  }
  return (
    <div className={`group/line flex min-w-0 flex-1 ${tint[line.kind]}`}>
      {mark}
      {pick}
      <span style={{ width: gutter }} className={number} aria-hidden="true">
        {lineNumber}
      </span>
      <span className={`w-4 shrink-0 select-none ${markerTint[line.kind]}`} aria-hidden="true">
        {marker[line.kind]}
      </span>
      {line.kind === "context" ? null : (
        <span className="sr-only">{line.kind === "removed" ? "Removed: " : "Added: "}</span>
      )}
      <span className={`min-w-0 pr-4 ${wrap ? "whitespace-pre-wrap wrap-anywhere" : "whitespace-pre"}`}>
        {line.text === ""
          ? " "
          : pieces(line.text, tokens, ranges).map((piece, index) => (
              <Run key={index} piece={piece} mark={wordMark[line.kind]} />
            ))}
      </span>
    </div>
  );
}

/**
 * A file's changes against the last commit: unified (one column, as git prints it) or split (the
 * old file beside the new), highlighted for the file's language, the words that changed within a
 * line picked out, and the unchanged stretches between changes folded to a line that shows the whole
 * file when pressed.
 */
export function DiffView({
  hunks,
  path,
  layout,
  onExpand,
  scroll = true,
  after,
  picking,
  commenting,
}: {
  hunks: ReadonlyArray<DiffHunk>;
  path: string;
  layout: DiffLayout;
  /** Shows every unchanged line; absent once they all show. */
  onExpand: (() => void) | undefined;
  /**
   * The diff scrolls itself, filling its parent. Without, its lines wrap and the page it's on
   * scrolls, as a pull request's files do one after another.
   */
  scroll?: boolean;
  /** What shows across the diff under a line: the review threads on it. */
  after?: ((line: NumberedLine) => ReactNode) | undefined;
  /** Its changed lines can be picked, and its hunks acted on. */
  picking?: DiffPicking | undefined;
  /** A run of its lines is being commented on, from the + that hovers over each one. */
  commenting?: DiffCommenting | undefined;
}) {
  /** The box for a hunk's line, a spacer for an unchanged one; nothing while lines can't be picked. */
  const pickOf = (hunk: number, index: number, line: NumberedLine) =>
    picking === undefined ? undefined : line.kind === "context" ? (
      <NoPick />
    ) : (
      <Pick picked={picking.picked(hunk, index)} onPick={(extend) => picking.onPick(hunk, index, extend)} />
    );
  const edgeOf = (hunk: number, index: number, line: NumberedLine) =>
    picking !== undefined && line.kind !== "context" && picking.picked(hunk, index) ? pickedEdge : "";
  // The run of lines a comment is being written on, held to the diff it was picked on: one that
  // reads differently again isn't it any more.
  const [heldHunks, setHeldHunks] = useState(hunks);
  const [run, setRun] = useState<{ readonly ids: ReadonlySet<string>; readonly anchor: string }>();
  if (heldHunks !== hunks || (commenting === undefined && run !== undefined)) {
    setHeldHunks(hunks);
    setRun(undefined);
  }
  const numbered = useNumbered(hunks, path);
  const { ranges, oldTokens, newTokens } = numbered;

  /** The run's lines, in the order the diff shows them, as the comment will carry them. */
  const markedLines = (ids: ReadonlySet<string>) =>
    [...ids].toSorted(orderedId).flatMap((id) => {
      const [hunk, index] = runAt(id);
      const line = numbered.hunks[hunk]?.lines[index];
      if (line === undefined) return [];
      return [
        {
          marker:
            line.kind === "added"
              ? ("+" as const)
              : line.kind === "removed"
                ? ("-" as const)
                : (" " as const),
          text: line.text,
          number: line.new ?? line.old ?? 0,
        },
      ];
    });
  const pickedLines = run === undefined ? [] : markedLines(run.ids);
  const runFirst = pickedLines[0]?.number ?? 0;
  const runEnd = pickedLines.at(-1)?.number ?? 0;
  const runRange =
    pickedLines.length === 0
      ? ""
      : `${path}:${lineRange(Math.min(runFirst, runEnd), Math.max(runFirst, runEnd))}`;

  const pickRun = (hunk: number, index: number, extend: boolean) => {
    if (commenting === undefined) return;
    const id = runId(hunk, index);
    if (extend && run !== undefined) {
      const ids = new Set(run.ids);
      for (const each of linesBetween(hunks, run.anchor, id)) ids.add(each);
      setRun({ ids, anchor: run.anchor });
    } else {
      setRun({ ids: new Set([id]), anchor: id });
    }
  };
  const plusOf = (hunk: number, index: number) =>
    commenting === undefined ? undefined : (
      <CommentPlus
        picked={run !== undefined && run.ids.has(runId(hunk, index))}
        onPick={(extend) => pickRun(hunk, index, extend)}
      />
    );
  /** A line a waiting comment covers, marked down its edge at half the pick's strength. */
  const markedEdge = "shadow-[inset_2px_0_0_color-mix(in_srgb,var(--color-accent)_45%,transparent)]";
  const markOf = (line: NumberedLine) =>
    commenting !== undefined && commenting.marked.has(line.new ?? line.old ?? 0) ? markedEdge : "";
  /** The comment box under the run's last line; nothing while there's no run. */
  const boxOf = (hunk: number, index: number) =>
    run === undefined || runAfter === undefined || runAfter !== runId(hunk, index) ? null : (
      /** As wide as the visible view and pinned left, so sideways-scrolling never carries it away. */
      <div className="sticky left-0" style={{ width: "100cqw" }}>
        <CommentBox
          range={runRange}
          lines={pickedLines.length}
          onAdd={(text) => {
            if (commenting === undefined || text.trim() === "" || pickedLines.length === 0) return;
            commenting.onAdd({
              quote: pickedLines.map((line) => `${line.marker} ${line.text}`).join("\n"),
              file: {
                path,
                start: Math.min(runFirst, runEnd),
                end: Math.max(runFirst, runEnd),
                lines: pickedLines,
              },
              text: text.trim(),
            });
            setRun(undefined);
          }}
          onClose={() => setRun(undefined)}
        />
      </div>
    );
  /** The run's last line, where the comment box hangs under. */
  const runAfter = run === undefined ? undefined : [...run.ids].toSorted(orderedId).at(-1);
  // Commenting elsewhere puts the run away, as picking a passage then clicking apart does.
  useEffect(() => {
    if (run === undefined) return;
    const away = (event: PointerEvent) => {
      if (root.current === null || root.current.contains(event.target instanceof Node ? event.target : null))
        return;
      setRun(undefined);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [run]);
  const root = useRef<HTMLDivElement>(null);

  const tokensOf = (line: NumberedLine | undefined, side: "old" | "new") => {
    if (line === undefined) return undefined;
    return side === "old"
      ? line.oldIndex === undefined
        ? undefined
        : oldTokens?.[line.oldIndex]
      : line.newIndex === undefined
        ? undefined
        : newTokens?.[line.newIndex];
  };
  const last = hunks.at(-1);
  const widest = last === undefined ? 1 : Math.max(last.oldStart, last.newStart) + last.lines.length;
  const gutter = `calc(${String(widest).length}ch + 1rem)`;

  return (
    <div
      ref={root}
      className={`font-mono text-meta leading-[1.6] select-text [container-type:inline-size] ${scroll ? "scroll-thin h-full overflow-auto pb-3" : ""}`}
    >
      <div className={layout === "split" || !scroll ? "min-w-full" : "w-max min-w-full"}>
        {numbered.hunks.map((hunk, hunkIndex) => {
          const changed = ranges[hunkIndex]!;
          const indexOf = new Map(hunk.lines.map((line, index) => [line, index]));
          const actions = picking?.hunkActions(hunkIndex);
          return (
            <Fragment key={hunkIndex}>
              {actions !== undefined && actions !== null ? (
                <Gap lines={hunk.gapBefore} onExpand={onExpand}>
                  {actions}
                </Gap>
              ) : hunk.gapBefore > 0 ? (
                <Gap lines={hunk.gapBefore} onExpand={onExpand} />
              ) : hunkIndex === 0 && scroll ? (
                <div className="h-3" />
              ) : null}
              {layout === "unified"
                ? chunksOf(hunk.lines).map(({ first, rows }) => (
                    <VisibleChunk key={first} height={rows.length * LINE_HEIGHT}>
                      {() =>
                        rows.map((line, offset) => {
                          const index = first + offset;
                          return (
                            <Fragment key={index}>
                              <div
                                className={`group/line flex ${tint[line.kind]} ${edgeOf(hunkIndex, index, line)} ${markOf(line)}`}
                              >
                                {plusOf(hunkIndex, index)}
                                {pickOf(hunkIndex, index, line)}
                                <span style={{ width: gutter }} className={number} aria-hidden="true">
                                  {line.old}
                                </span>
                                <Cell
                                  line={line}
                                  number={line.new}
                                  ranges={changed.get(index) ?? []}
                                  tokens={tokensOf(line, line.kind === "removed" ? "old" : "new")}
                                  gutter={gutter}
                                  wrap={!scroll}
                                />
                              </div>
                              {after?.(line)}
                              {commenting?.under?.(line)}
                              {boxOf(hunkIndex, index)}
                            </Fragment>
                          );
                        })
                      }
                    </VisibleChunk>
                  ))
                : chunksOf(splitRows(hunk.lines)).map(({ first, rows }) => (
                    <VisibleChunk key={first} height={rows.length * LINE_HEIGHT}>
                      {() =>
                        rows.map((row, offset) => (
                          <Fragment key={first + offset}>
                            <div className="grid grid-cols-2 divide-x divide-line-subtle">
                              <div
                                className={`flex min-w-0 ${row.left ? `${edgeOf(hunkIndex, indexOf.get(row.left)!, row.left)} ${markOf(row.left)}` : ""}`}
                              >
                                <Cell
                                  line={row.left}
                                  number={row.left?.old}
                                  ranges={row.left ? (changed.get(indexOf.get(row.left)!) ?? []) : []}
                                  tokens={tokensOf(row.left, "old")}
                                  gutter={gutter}
                                  wrap
                                  mark={row.left ? plusOf(hunkIndex, indexOf.get(row.left)!) : undefined}
                                  pick={
                                    row.left ? pickOf(hunkIndex, indexOf.get(row.left)!, row.left) : undefined
                                  }
                                />
                              </div>
                              <div
                                className={`flex min-w-0 ${row.right && row.right.kind !== "context" ? `${edgeOf(hunkIndex, indexOf.get(row.right)!, row.right)} ${markOf(row.right)}` : ""}`}
                              >
                                <Cell
                                  wrap
                                  line={row.right}
                                  number={row.right?.new}
                                  ranges={
                                    row.right && row.right.kind !== "context"
                                      ? (changed.get(indexOf.get(row.right)!) ?? [])
                                      : []
                                  }
                                  tokens={tokensOf(row.right, "new")}
                                  gutter={gutter}
                                  mark={
                                    row.right && row.right.kind !== "context"
                                      ? plusOf(hunkIndex, indexOf.get(row.right)!)
                                      : undefined
                                  }
                                  pick={
                                    row.right
                                      ? pickOf(hunkIndex, indexOf.get(row.right)!, row.right)
                                      : undefined
                                  }
                                />
                              </div>
                            </div>
                            {row.left ? after?.(row.left) : null}
                            {row.right && row.right !== row.left ? after?.(row.right) : null}
                            {row.left ? commenting?.under?.(row.left) : null}
                            {row.right && row.right !== row.left ? commenting?.under?.(row.right) : null}
                            {row.left ? boxOf(hunkIndex, indexOf.get(row.left)!) : null}
                            {row.right && row.right !== row.left
                              ? boxOf(hunkIndex, indexOf.get(row.right)!)
                              : null}
                          </Fragment>
                        ))
                      }
                    </VisibleChunk>
                  ))}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
