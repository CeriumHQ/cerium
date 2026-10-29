import { createContext, useContext, type CSSProperties } from "react";

import { useHighlight, type Line } from "./highlight.ts";
import type { Piece } from "./model.ts";
import { VisibleChunk } from "./VisibleChunk.tsx";

/** Lines drawn together; the browser skips painting the ones scrolled far out of view. */
export const CHUNK = 100;
/** A line's height: 12.5px text, 1.6 apart. */
export const LINE_HEIGHT = 20;

/**
 * What a line's number does when clicked: opens the file in the user's editor at that line. Absent
 * where there is no editor to open it in, so the numbers stay plain.
 */
export const OpenAtLine = createContext<
  { readonly open: (line: number) => void; readonly label: string } | undefined
>(undefined);

/** A line's number in the gutter; a button that opens the line in the editor when the viewer has one. */
export function LineNumber({
  line,
  className,
  style,
}: {
  line: number;
  className: string;
  style?: CSSProperties;
}) {
  const opener = useContext(OpenAtLine);
  if (opener === undefined) {
    return (
      <span style={style} className={className} aria-hidden="true">
        {line}
      </span>
    );
  }
  return (
    <button
      type="button"
      tabIndex={-1}
      title={`Open line ${line} in ${opener.label}`}
      onClick={() => opener.open(line)}
      style={style}
      className={`${className} cursor-pointer transition-colors hover:text-fg-primary hover:underline`}
    >
      {line}
    </button>
  );
}

/** A run of highlighted text; a colourless run is plain text. */
export function Run({ piece, mark }: { piece: Piece; mark?: string }) {
  const style: CSSProperties | undefined =
    piece.color === undefined && piece.italic !== true
      ? undefined
      : { ...(piece.color ? { color: piece.color } : {}), ...(piece.italic ? { fontStyle: "italic" } : {}) };
  if (style === undefined && !piece.marked) return piece.text;
  return (
    <span style={style} className={piece.marked ? mark : undefined}>
      {piece.text}
    </span>
  );
}

/** A line's tokens, or its plain text until the highlighter has them. */
export function LineText({ text, tokens }: { text: string; tokens: Line | undefined }) {
  if (text === "") return " ";
  if (tokens === undefined) return text;
  return tokens.map(([content, color, italic], index) => (
    <Run
      key={index}
      piece={{
        text: content,
        ...(color === undefined ? {} : { color }),
        ...(italic === 1 ? { italic: true } : {}),
        marked: false,
      }}
    />
  ));
}

/**
 * A file's text with its line numbers, highlighted for the language its name says. `wrap` folds
 * long lines to the width instead of scrolling sideways.
 */
export function CodeView({ text, path, wrap }: { text: string; path: string; wrap: boolean }) {
  const highlighted = useHighlight(text, path);
  const lines = text.split("\n");
  // A file's final newline isn't a line of its own.
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const gutter = `calc(${String(lines.length).length}ch + 2.25rem)`;
  const chunks = Array.from({ length: Math.ceil(lines.length / CHUNK) }, (_, index) => index * CHUNK);
  return (
    <div className="scroll-thin h-full overflow-auto py-3 font-mono text-meta leading-[1.6] select-text">
      <div className={wrap ? "min-w-0" : "w-max min-w-full"}>
        {chunks.map((first) => {
          const shown = lines.slice(first, first + CHUNK);
          return (
            <VisibleChunk key={first} height={shown.length * LINE_HEIGHT}>
              {() =>
                shown.map((line, index) => (
                  <div
                    key={first + index}
                    className={`flex pr-6 hover:bg-surface-hover ${wrap ? "whitespace-pre-wrap" : "whitespace-pre"}`}
                  >
                    <LineNumber
                      line={first + index + 1}
                      style={{ width: gutter }}
                      className="shrink-0 pr-4 pl-3 text-right text-fg-disabled tabular-nums select-none"
                    />
                    <span className={`min-w-0 text-fg-primary ${wrap ? "break-all" : ""}`}>
                      <LineText text={line.replace(/\r$/, "")} tokens={highlighted?.[first + index]} />
                    </span>
                  </div>
                ))
              }
            </VisibleChunk>
          );
        })}
      </div>
    </div>
  );
}
