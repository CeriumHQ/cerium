import type { DiffHunk } from "@cerium/rpc";

import { marker, markerTint, tint } from "../transcript/EditDiff.tsx";
import {
  highlightLines,
  languageOf,
  tokenize,
  type Language,
  type Token,
  type TokenKind,
} from "./highlight.ts";

const tokenClass: Readonly<Record<TokenKind, string>> = {
  plain: "",
  comment: "text-fg-tertiary",
  string: "text-syntax-string",
  number: "text-syntax-number",
  keyword: "text-syntax-keyword",
  type: "text-syntax-type",
  key: "text-syntax-type",
  tag: "text-syntax-keyword",
  attr: "text-syntax-type",
};

function Tokens({ tokens }: { tokens: ReadonlyArray<Token> }) {
  return tokens.map((token, index) =>
    token.kind === "plain" ? (
      token.text
    ) : (
      <span key={index} className={tokenClass[token.kind]}>
        {token.text}
      </span>
    ),
  );
}

/** Lines drawn together; the browser skips painting the ones that are scrolled far out of view. */
const CHUNK = 100;
const LINE_HEIGHT = 19.2;

const chunked = { contentVisibility: "auto" } as const;

/** A file's text with its line numbers, highlighted by what its name says it is. */
export function CodeView({ text, path }: { text: string; path: string }) {
  const lines = highlightLines(text, languageOf(path));
  const gutter = `${String(lines.length).length + 1}ch`;
  const chunks = Array.from({ length: Math.ceil(lines.length / CHUNK) }, (_, index) => index * CHUNK);
  return (
    <div className="scroll-thin h-full overflow-auto py-2 font-mono text-[12px] leading-[1.6] select-text">
      <div className="w-max min-w-full">
        {chunks.map((first) => {
          const shown = lines.slice(first, first + CHUNK);
          return (
            <div
              key={first}
              style={{ ...chunked, containIntrinsicSize: `auto ${shown.length * LINE_HEIGHT}px` }}
            >
              {shown.map((tokens, index) => (
                <div key={first + index} className="flex px-3 whitespace-pre">
                  <span
                    style={{ width: gutter }}
                    className="shrink-0 pr-3 text-right text-fg-disabled tabular-nums select-none"
                    aria-hidden="true"
                  >
                    {first + index + 1}
                  </span>
                  <span className="text-fg-primary">
                    <Tokens tokens={tokens} />
                    {tokens.length === 0 ? " " : null}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The line each line of a hunk is at in the new file; removed lines have none. */
const lineNumbers = (hunk: DiffHunk): ReadonlyArray<number | undefined> => {
  let next = hunk.newStart;
  return hunk.lines.map((line) => (line.kind === "removed" ? undefined : next++));
};

/** A file's changes as hunks of lines, the unchanged ones around them in a quieter tone. */
export function DiffView({ hunks, path }: { hunks: ReadonlyArray<DiffHunk>; path: string }) {
  const language: Language | undefined = languageOf(path);
  const last = hunks.at(-1);
  const widest = last === undefined ? 1 : last.newStart + last.lines.length;
  const gutter = `${String(widest).length + 1}ch`;
  return (
    <div className="scroll-thin h-full overflow-auto py-2 font-mono text-[12px] leading-[1.6] select-text">
      <div className="grid w-max min-w-full">
        {hunks.map((hunk, hunkIndex) => {
          const numbers = lineNumbers(hunk);
          return (
            <div key={hunkIndex}>
              {hunkIndex > 0 ? (
                <div className="px-3 py-1 text-fg-disabled select-none" aria-hidden="true">
                  ⋯
                </div>
              ) : null}
              {hunk.lines.map((line, index) => {
                return (
                  <div key={index} className={`flex px-3 whitespace-pre ${tint[line.kind]}`}>
                    <span
                      style={{ width: gutter }}
                      className="shrink-0 pr-3 text-right text-fg-disabled tabular-nums select-none"
                      aria-hidden="true"
                    >
                      {numbers[index]}
                    </span>
                    <span className={`w-4 shrink-0 select-none ${markerTint[line.kind]}`} aria-hidden="true">
                      {marker[line.kind]}
                    </span>
                    {line.kind === "context" ? null : (
                      <span className="sr-only">{line.kind === "removed" ? "Removed: " : "Added: "}</span>
                    )}
                    <span>{line.text === "" ? " " : <Tokens tokens={tokenize(line.text, language)} />}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
