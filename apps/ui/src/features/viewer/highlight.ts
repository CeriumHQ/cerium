import { useEffect, useState } from "react";

// The viewer's syntax highlighting, asked of a worker (highlight.worker.ts) so a long file never
// holds up the window. What it last highlighted is kept, so going back to a tab shows it at once.

/** A run of text: what it says, its colour (a CSS value, none for the text's own) and 1 when italic. */
export type Token = readonly [text: string, color?: string | undefined, italic?: 1];
export type Line = ReadonlyArray<Token>;

export interface HighlightRequest {
  readonly id: number;
  readonly text: string;
  /** The file's path, which says what language it's in. */
  readonly path: string;
}

export interface HighlightResponse {
  readonly id: number;
  /** One entry per line; none when the file's language has no grammar. */
  readonly lines: ReadonlyArray<Line> | undefined;
}

/** How many highlighted texts are kept. */
const KEPT = 16;

let worker: Worker | undefined;
let nextId = 0;
const waiting = new Map<number, (lines: ReadonlyArray<Line> | undefined) => void>();
const kept = new Map<string, ReadonlyArray<Line> | undefined>();

const keyOf = (text: string, path: string) => `${path}\0${text}`;

const getWorker = () => {
  if (worker === undefined) {
    worker = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (event: MessageEvent<HighlightResponse>) => {
      waiting.get(event.data.id)?.(event.data.lines);
      waiting.delete(event.data.id);
    });
  }
  return worker;
};

/** `text` highlighted as the language `path` names, or undefined when it can't be. */
export const highlight = (text: string, path: string): Promise<ReadonlyArray<Line> | undefined> => {
  const key = keyOf(text, path);
  if (kept.has(key)) return Promise.resolve(kept.get(key));
  if (typeof Worker === "undefined") return Promise.resolve(undefined);
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, (lines) => {
      kept.delete(key);
      kept.set(key, lines);
      if (kept.size > KEPT) kept.delete(kept.keys().next().value!);
      resolve(lines);
    });
    getWorker().postMessage({ id, text, path } satisfies HighlightRequest);
  });
};

/**
 * `text` highlighted as `path`'s language once the worker has done it; undefined until then (and
 * for a language without a grammar), when the text shows uncoloured.
 */
export function useHighlight(text: string | undefined, path: string): ReadonlyArray<Line> | undefined {
  const [done, setDone] = useState<{ key: string; lines: ReadonlyArray<Line> | undefined }>();
  const key = text === undefined ? undefined : keyOf(text, path);
  useEffect(() => {
    if (text === undefined || key === undefined) return;
    let current = true;
    void highlight(text, path).then((lines) => {
      if (current) setDone({ key, lines });
    });
    return () => {
      current = false;
    };
  }, [text, path, key]);
  if (key === undefined) return undefined;
  return done?.key === key ? done.lines : kept.get(key);
}
