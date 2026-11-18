import { useEffect, useMemo, useState } from "react";

/** A run of text: what it says, its colour (a CSS value, none for the text's own) and 1 when italic. */
export type Token = readonly [text: string, color?: string | undefined, italic?: 1];
export type Line = ReadonlyArray<Token>;
export type HighlightedLines = ReadonlyArray<Line | undefined>;
export type HighlightSource = { readonly text: string; readonly path: string };

export type HighlightRequest =
  | { readonly type: "open"; readonly document: number; readonly text: string; readonly path: string }
  | { readonly type: "close"; readonly document: number }
  | {
      readonly type: "range";
      readonly id: number;
      readonly document: number;
      readonly first: number;
      readonly end: number;
    }
  | { readonly type: "cancel"; readonly id: number };

export interface HighlightResponse {
  readonly id: number;
  /** The requested lines, starting at the requested index. Missing lines render as plain text. */
  readonly lines: HighlightedLines | undefined;
}

const KEPT_RANGES = 128;
const KEPT_BYTES = 4 * 1024 * 1024;

type Listener = (lines: HighlightedLines | undefined) => void;
type Pending = { readonly id: number; readonly key: string; readonly listeners: Set<Listener> };
type Session = { readonly id: number; subscribers: number; opened?: Worker };

let worker: Worker | undefined;
let nextId = 0;
const sessions = new WeakMap<HighlightSource, Session>();
const waiting = new Map<number, Pending>();
const ranges = new Map<string, Pending>();
const kept = new Map<string, { readonly lines: HighlightedLines | undefined; readonly size: number }>();
let keptBytes = 0;

const rangeKey = (session: Session, first: number, end: number) => `${session.id}:${first}:${end}`;

/** Approximate the size of arrays, token tuples and their text, including the cost of very dense tokens. */
function remember(key: string, lines: HighlightedLines | undefined) {
  let size = 64;
  for (const line of lines ?? []) {
    size += 32;
    if (size > KEPT_BYTES) return;
    for (const [text, color] of line ?? []) {
      size += 48 + 2 * (text.length + (color?.length ?? 0));
      if (size > KEPT_BYTES) return;
    }
  }
  kept.set(key, { lines, size });
  keptBytes += size;
  while (keptBytes > KEPT_BYTES || kept.size > KEPT_RANGES) {
    const oldest = kept.keys().next().value!;
    keptBytes -= kept.get(oldest)!.size;
    kept.delete(oldest);
  }
}

/** Pending ranges fall back to plain text if the worker goes away. */
function lose(lost: Worker) {
  if (worker !== lost) return;
  worker = undefined;
  lost.terminate();
  const pending = [...waiting.values()];
  waiting.clear();
  ranges.clear();
  for (const { listeners } of pending) for (const listen of listeners) listen(undefined);
}

function getWorker() {
  if (worker === undefined && typeof Worker !== "undefined") {
    try {
      worker = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" });
    } catch {
      return undefined;
    }
    const created = worker;
    created.addEventListener("message", (event: MessageEvent<HighlightResponse>) => {
      if (worker !== created) return;
      const { id, lines } = event.data;
      const pending = waiting.get(id);
      if (pending === undefined) return;
      waiting.delete(id);
      ranges.delete(pending.key);
      remember(pending.key, lines);
      for (const listen of pending.listeners) listen(lines);
    });
    created.addEventListener("error", () => lose(created));
    created.addEventListener("messageerror", () => lose(created));
  }
  return worker;
}

function subscribe(source: HighlightSource, first: number, end: number, onResult: Listener) {
  let session = sessions.get(source);
  if (session === undefined) {
    session = { id: nextId++, subscribers: 0 };
    sessions.set(source, session);
  }
  const key = rangeKey(session, first, end);
  session.subscribers++;
  const cached = kept.get(key);
  let pending: Pending | undefined;
  let current = true;
  const listener: Listener = (lines) => {
    if (current) onResult(lines);
  };
  if (cached !== undefined) {
    kept.delete(key);
    kept.set(key, cached);
    queueMicrotask(() => listener(cached.lines));
  } else {
    const target = getWorker();
    if (target !== undefined) {
      if (session.opened !== target) {
        target.postMessage({ type: "open", document: session.id, ...source } satisfies HighlightRequest);
        session.opened = target;
      }
      pending = ranges.get(key);
      if (pending === undefined) {
        pending = { id: nextId++, key, listeners: new Set() };
        ranges.set(key, pending);
        waiting.set(pending.id, pending);
        target.postMessage({
          type: "range",
          id: pending.id,
          document: session.id,
          first,
          end,
        } satisfies HighlightRequest);
      }
      pending.listeners.add(listener);
    }
  }

  const activeSession = session;
  return () => {
    current = false;
    if (
      pending !== undefined &&
      pending.listeners.delete(listener) &&
      pending.listeners.size === 0 &&
      waiting.delete(pending.id)
    ) {
      ranges.delete(key);
      worker?.postMessage({ type: "cancel", id: pending.id } satisfies HighlightRequest);
    }
    activeSession.subscribers--;
    // Adjacent ranges can mount and unmount in the same render. Keep their shared source open.
    if (activeSession.subscribers === 0) {
      queueMicrotask(() => {
        const opened = activeSession.opened;
        if (activeSession.subscribers !== 0 || opened === undefined) return;
        if (opened === worker)
          opened.postMessage({ type: "close", document: activeSession.id } satisfies HighlightRequest);
        delete activeSession.opened;
      });
    }
  };
}

export function useHighlightSource(text: string | undefined, path: string): HighlightSource | undefined {
  return useMemo(() => (text === undefined ? undefined : { text, path }), [text, path]);
}

/** Requests the displayed range [first, end). A pending or unsupported range renders as plain text. */
export function useHighlightRange(
  source: HighlightSource | undefined,
  first: number,
  end: number,
  visible = true,
): HighlightedLines | undefined {
  const [done, setDone] = useState<{
    source: HighlightSource;
    first: number;
    end: number;
    lines: HighlightedLines | undefined;
  }>();
  useEffect(() => {
    if (visible && source !== undefined && first < end) {
      return subscribe(source, first, end, (lines) => setDone({ source, first, end, lines }));
    }
  }, [source, first, end, visible]);
  if (done !== undefined && done.source === source && done.first === first && done.end === end) {
    return done.lines;
  }
  const session = source === undefined ? undefined : sessions.get(source);
  return session === undefined ? undefined : kept.get(rangeKey(session, first, end))?.lines;
}

/** Highlights code snippets that are rendered all at once. */
export function useHighlight(text: string | undefined, path: string): HighlightedLines | undefined {
  return useHighlightRange(useHighlightSource(text, path), 0, Number.POSITIVE_INFINITY);
}
