import type { DiffHunk } from "@cerium/rpc";
import { ChevronsUpDown } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { Run } from "./CodeView.tsx";
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

/** The unchanged lines a diff leaves out between two hunks, with a way to show the whole file. */
function Gap({ lines, onExpand }: { lines: number; onExpand: (() => void) | undefined }) {
  const label = lines === 1 ? "1 unchanged line" : `${lines.toLocaleString()} unchanged lines`;
  return (
    <div className="flex h-7 items-center border-y border-line-subtle bg-surface-hover text-[11.5px] text-fg-tertiary select-none">
      {onExpand ? (
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
    </div>
  );
}

/** One side's line: its number, its marker, and its text with the changed words picked out. */
function Cell({
  line,
  number: lineNumber,
  ranges,
  tokens,
  gutter,
  wrap = false,
}: {
  line: NumberedLine | undefined;
  number: number | undefined;
  ranges: ReadonlyArray<Range>;
  tokens: Parameters<typeof pieces>[1];
  gutter: string;
  /** Long lines wrap rather than run past the side's edge, as each side of a split diff does. */
  wrap?: boolean;
}) {
  if (line === undefined) {
    return <div className="min-w-0 flex-1 bg-surface-hover/60" aria-hidden="true" />;
  }
  return (
    <div className={`flex min-w-0 flex-1 ${tint[line.kind]}`}>
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
}) {
  const numbered = numberHunks(hunks);
  const oldTokens = useHighlight(numbered.oldText, path);
  const newTokens = useHighlight(numbered.newText, path);
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

  /** The words each changed line lost or gained against the line it replaced, by index in the hunk. */
  const rangesOf = (lines: ReadonlyArray<NumberedLine>) => {
    const pairs = replacedPairs(lines);
    const ranges = new Map<number, ReadonlyArray<Range>>();
    for (const [index, other] of pairs) {
      const line = lines[index]!;
      if (line.kind !== "removed") continue;
      const words = changedWords(line.text, lines[other]!.text);
      if (words === undefined) continue;
      ranges.set(index, words.removed);
      ranges.set(other, words.added);
    }
    return ranges;
  };

  return (
    <div
      className={`font-mono text-[12.5px] leading-[1.6] select-text ${scroll ? "scroll-thin h-full overflow-auto pb-3" : ""}`}
    >
      <div className={layout === "split" || !scroll ? "min-w-full" : "w-max min-w-full"}>
        {numbered.hunks.map((hunk, hunkIndex) => {
          const ranges = rangesOf(hunk.lines);
          const indexOf = new Map(hunk.lines.map((line, index) => [line, index]));
          return (
            <Fragment key={hunkIndex}>
              {hunk.gapBefore > 0 ? (
                <Gap lines={hunk.gapBefore} onExpand={onExpand} />
              ) : hunkIndex === 0 && scroll ? (
                <div className="h-3" />
              ) : null}
              {layout === "unified"
                ? hunk.lines.map((line, index) => (
                    <Fragment key={index}>
                      <div className={`flex ${tint[line.kind]}`}>
                        <span style={{ width: gutter }} className={number} aria-hidden="true">
                          {line.old}
                        </span>
                        <Cell
                          line={line}
                          number={line.new}
                          ranges={ranges.get(index) ?? []}
                          tokens={tokensOf(line, line.kind === "removed" ? "old" : "new")}
                          gutter={gutter}
                          wrap={!scroll}
                        />
                      </div>
                      {after?.(line)}
                    </Fragment>
                  ))
                : splitRows(hunk.lines).map((row, index) => (
                    <Fragment key={index}>
                      <div className="grid grid-cols-2 divide-x divide-line-subtle">
                        <div className="flex min-w-0">
                          <Cell
                            line={row.left}
                            number={row.left?.old}
                            ranges={row.left ? (ranges.get(indexOf.get(row.left)!) ?? []) : []}
                            tokens={tokensOf(row.left, "old")}
                            gutter={gutter}
                            wrap
                          />
                        </div>
                        <div className="flex min-w-0">
                          <Cell
                            wrap
                            line={row.right}
                            number={row.right?.new}
                            ranges={
                              row.right && row.right.kind !== "context"
                                ? (ranges.get(indexOf.get(row.right)!) ?? [])
                                : []
                            }
                            tokens={tokensOf(row.right, "new")}
                            gutter={gutter}
                          />
                        </div>
                      </div>
                      {row.left ? after?.(row.left) : null}
                      {row.right && row.right !== row.left ? after?.(row.right) : null}
                    </Fragment>
                  ))}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
