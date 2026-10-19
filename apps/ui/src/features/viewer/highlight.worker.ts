// Highlights files for the viewer off the main thread: Shiki with its JavaScript regex engine (no
// WebAssembly to admit), each grammar loaded the first time a file needs it.

import { createCssVariablesTheme, createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages } from "shiki/langs";

import type { HighlightRequest, HighlightResponse, Line, Token } from "./highlight.ts";
import { languageOf } from "./language.ts";

const THEME = "cerium";

/** Lines longer than this are left plain: minified code would take seconds and show nothing useful. */
const MAX_LINE = 4_000;
/** How long one file may take before the rest of it is left plain. */
const TIME_LIMIT = 1_500;

let highlighter: Promise<HighlighterCore> | undefined;
const loaded = new Map<string, Promise<boolean>>();

const getHighlighter = () =>
  (highlighter ??= createHighlighterCore({
    themes: [createCssVariablesTheme({ name: THEME, variablePrefix: "--shiki-" })],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }));

const known = (id: string) => Object.hasOwn(bundledLanguages, id);

/** Loads `lang`'s grammar once; whether it could be. */
const load = (core: HighlighterCore, lang: string) => {
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
};

const highlight = async ({ text, path }: HighlightRequest): Promise<ReadonlyArray<Line> | undefined> => {
  const lang = languageOf(path, known);
  if (lang === "txt") return undefined;
  const core = await getHighlighter();
  if (!(await load(core, lang))) return undefined;
  const lines = core.codeToTokensBase(text, {
    lang,
    theme: THEME,
    tokenizeMaxLineLength: MAX_LINE,
    tokenizeTimeLimit: TIME_LIMIT,
  });
  return lines.map((tokens) =>
    tokens.map((token): Token => {
      const color = token.color === "var(--shiki-foreground)" ? undefined : token.color;
      const italic = token.fontStyle !== undefined && token.fontStyle > 0 && (token.fontStyle & 1) === 1;
      return italic
        ? [token.content, color, 1]
        : color === undefined
          ? [token.content]
          : [token.content, color];
    }),
  );
};

self.addEventListener("message", (event: MessageEvent<HighlightRequest>) => {
  const { id } = event.data;
  highlight(event.data).then(
    (lines) => self.postMessage({ id, lines } satisfies HighlightResponse),
    () => self.postMessage({ id, lines: undefined } satisfies HighlightResponse),
  );
});
