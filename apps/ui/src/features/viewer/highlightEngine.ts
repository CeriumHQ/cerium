// Shiki runs off the main thread with its JavaScript regex engine. Each grammar loads on demand.
import {
  createCssVariablesTheme,
  createHighlighterCore,
  type GrammarState,
  type HighlighterCore,
  type ThemedToken,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages } from "shiki/langs";

import type { HighlightRequest, HighlightResponse, Line, Token } from "./highlight.ts";
import { languageOf } from "./language.ts";

const THEME = "cerium";
const MAX_LINE = 4_000;
const LINE_TIME_LIMIT = 1_500;
const BATCH_LINES = 100;
const KEPT_STATES = 128;

let highlighter: Promise<HighlighterCore> | undefined;
const loaded = new Map<string, Promise<boolean>>();

const getHighlighter = () =>
  (highlighter ??= createHighlighterCore({
    themes: [createCssVariablesTheme({ name: THEME, variablePrefix: "--shiki-" })],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }));

const known = (id: string) => Object.hasOwn(bundledLanguages, id);

function load(core: HighlighterCore, lang: string) {
  let pending = loaded.get(lang);
  if (pending === undefined) {
    const grammar = bundledLanguages[lang as keyof typeof bundledLanguages];
    pending = core.loadLanguage(grammar).then(
      () => true,
      () => false,
    );
    loaded.set(lang, pending);
  }
  return pending;
}

function compactToken(token: ThemedToken): Token {
  const color = token.color === "var(--shiki-foreground)" ? undefined : token.color;
  const italic = token.fontStyle !== undefined && token.fontStyle > 0 && (token.fontStyle & 1) === 1;
  return italic ? [token.content, color, 1] : color === undefined ? [token.content] : [token.content, color];
}

type Source = { readonly lang: string; readonly lines: ReadonlyArray<string> };
type Job = {
  readonly request: Extract<HighlightRequest, { type: "range" }>;
  readonly source: Source;
  readonly end: number;
  readonly lines: Array<Line | undefined>;
  next: number;
  state: GrammarState | undefined;
};
type Checkpoint = { readonly document: number; readonly line: number; readonly state: GrammarState };

export function createHighlightWorker(send: (response: HighlightResponse) => void) {
  const sources = new Map<number, Source>();
  const jobs = new Map<number, Job>();
  const ready = new Set<Job>();
  const checkpoints = new Map<string, Checkpoint>();
  let scheduled = false;

  function finish(id: number, lines: HighlightResponse["lines"]) {
    if (jobs.delete(id)) send({ id, lines });
  }

  function step(core: HighlighterCore, job: Job) {
    const { document, first } = job.request;
    // A different range may already have scanned some of our prefix. Reuse its closest state.
    let closest: [string, Checkpoint] | undefined;
    for (const entry of checkpoints) {
      const { document: owner, line } = entry[1];
      if (owner === document && line > (closest?.[1].line ?? job.next) && line <= first) closest = entry;
    }
    if (closest !== undefined) {
      const [key, checkpoint] = closest;
      checkpoints.delete(key);
      checkpoints.set(key, checkpoint);
      job.next = checkpoint.line;
      job.state = checkpoint.state;
    }

    const contextOnly = job.next < first;
    const end = Math.min(job.next + BATCH_LINES, contextOnly ? first : job.end);
    const lines = job.source.lines.slice(job.next, end);
    // Shiki leaves its state alone for blank and oversized lines. Avoid copying oversized lines
    // into its input or the reply. The viewer already has their text.
    const text = lines.map((line) => (line.length >= MAX_LINE ? "" : line)).join("\r\n");
    const options = {
      lang: job.source.lang,
      theme: THEME,
      tokenizeTimeLimit: LINE_TIME_LIMIT,
      ...(job.state === undefined ? {} : { grammarState: job.state }),
    };
    if (contextOnly) {
      job.state = core.getLastGrammarState(text, options);
    } else {
      const { tokens, grammarState } = core.codeToTokens(text, options);
      job.state = grammarState;
      for (const [index, line] of lines.entries()) {
        job.lines.push(line.length >= MAX_LINE ? undefined : tokens[index]?.map(compactToken));
      }
    }
    job.next = end;
    if (job.state !== undefined) {
      const key = `${document}:${end}`;
      checkpoints.delete(key);
      checkpoints.set(key, { document, line: end, state: job.state });
      if (checkpoints.size > KEPT_STATES) checkpoints.delete(checkpoints.keys().next().value!);
    }
  }

  function schedule(core: HighlighterCore) {
    if (scheduled || ready.size === 0) return;
    scheduled = true;
    // Yield to incoming range and cancellation messages between batches. Each document can
    // move its visible ranges forward while another is still scanning a long prefix.
    setTimeout(() => {
      scheduled = false;
      const job = ready.values().next().value;
      if (job === undefined) return;
      ready.delete(job);
      try {
        step(core, job);
        if (job.next === job.end) finish(job.request.id, job.lines);
        else ready.add(job);
      } catch {
        finish(job.request.id, undefined);
      }
      schedule(core);
    }, 0);
  }

  function cancel(id: number) {
    const job = jobs.get(id);
    if (job !== undefined) ready.delete(job);
    jobs.delete(id);
  }

  async function prepare(id: number, lang: string) {
    try {
      const core = await getHighlighter();
      if (!jobs.has(id)) return;
      if (!(await load(core, lang))) {
        finish(id, undefined);
        return;
      }
      const job = jobs.get(id);
      if (job !== undefined) {
        ready.add(job);
        schedule(core);
      }
    } catch {
      finish(id, undefined);
    }
  }

  return (request: HighlightRequest) => {
    switch (request.type) {
      case "open": {
        const lang = languageOf(request.path, known);
        if (lang !== "txt") sources.set(request.document, { lang, lines: request.text.split(/\r?\n/) });
        break;
      }
      case "close":
        sources.delete(request.document);
        break;
      case "cancel":
        cancel(request.id);
        break;
      case "range": {
        const source = sources.get(request.document);
        const end = Math.min(request.end, source?.lines.length ?? 0);
        if (source === undefined || request.first >= end) {
          send({ id: request.id, lines: undefined });
          break;
        }
        jobs.set(request.id, { request, source, end, lines: [], next: 0, state: undefined });
        void prepare(request.id, source.lang);
        break;
      }
    }
  };
}
