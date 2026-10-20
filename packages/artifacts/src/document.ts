// The document an artifact renders as, and the host page its frame loads. The frame is sandboxed
// without `allow-same-origin`, so the page runs in an opaque origin: its scripts run and it may load
// from the web, but it can't reach the app, its storage or the user's machine.

import {
  artifactRuntime,
  MESSAGE_PREFIX,
  RENDER_MESSAGE,
  type RuntimeOptions,
  type ThemeUpdate,
} from "./runtime.ts";
import { THEME_TOKENS, themeCss, type ArtifactTheme } from "./theme.ts";

/**
 * What a page may do: run inline scripts and load scripts, styles, fonts, images and data over https.
 * Nothing over plain http, so a page can't reach the backend or other services on this machine.
 */
export const ARTIFACT_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https: blob: data:",
  "style-src 'unsafe-inline' https:",
  "img-src https: data: blob:",
  "font-src https: data:",
  "media-src https: data: blob:",
  "connect-src https: wss: data: blob:",
  "worker-src blob: data:",
  "frame-src https:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** The fonts the app sets text in, which a page uses through `--font-sans` and `--font-mono`. */
const FONT_STACKS = {
  sans: '"Red Hat Text Variable", ui-sans-serif, system-ui, sans-serif',
  mono: '"Red Hat Mono Variable", ui-monospace, "Cascadia Code", monospace',
};

/** `@font-face` rules for the app's fonts, given each as a URL (a `data:` URL in the frame). */
export const fontFaces = (fonts: { readonly sans: string; readonly mono: string }): string =>
  [
    `@font-face { font-family: "Red Hat Text Variable"; font-weight: 300 700; font-display: block; src: url(${fonts.sans}) format("woff2"); }`,
    `@font-face { font-family: "Red Hat Mono Variable"; font-weight: 300 700; font-display: block; src: url(${fonts.mono}) format("woff2"); }`,
  ].join("\n");

/**
 * What every page starts from, ahead of its own styles so they win: the app's type, the theme's text
 * colour on a transparent page, and no scrollbar, since the frame is always as tall as the page.
 */
const BASE_CSS = `:root { --radius: 10px; --radius-sm: 6px; --font-sans: ${FONT_STACKS.sans}; --font-mono: ${FONT_STACKS.mono}; }
html { color: var(--foreground); background: transparent; font-family: var(--font-sans); font-size: 14px; line-height: 1.6; font-size-adjust: ex-height 0.53; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; -webkit-text-size-adjust: 100%; scrollbar-width: none; }
html::-webkit-scrollbar { display: none; }
body { margin: 0; }
code, kbd, pre, samp { font-family: var(--font-mono); }
::selection { background: var(--selection); }
:where(:focus-visible) { outline: 2px solid var(--ring); outline-offset: 2px; }`;

/**
 * A page on its own, saved or opened in a browser: on the conversation's colour with room around it,
 * as wide as a reading column at most, and scrolling like any page.
 */
const STANDALONE_CSS = `html { background: var(--background); scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
body { box-sizing: border-box; max-width: 1048px; margin: 0 auto; padding: 32px 24px; }`;

/**
 * Whether an artifact was written for the frozen building blocks: a fragment with classes and neither
 * a stylesheet nor a script of its own, since a page designed for itself always brings one.
 */
export const isLegacyArtifact = (html: string): boolean => {
  const scan = blankRawText(html);
  return (
    !/^\s*<(!doctype|html|head)\b/i.test(scan) &&
    !/<(style|script|link)\b/i.test(html) &&
    /\bclass\s*=/i.test(scan)
  );
};

/** The theme as the window sends it to a frame, in the form the runtime swaps in. */
export const themeUpdate = (theme: ArtifactTheme, legacy: boolean): ThemeUpdate => ({
  mode: theme.mode,
  css: themeCss(theme, legacy ? LEGACY_ALIASES : undefined),
  variables: theme.variables,
});

/** For legacy pages, each theme variable under the Cerium token name the frozen stylesheet reads. */
const LEGACY_ALIASES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(THEME_TOKENS).filter(([name]) => !["--background", "--primary", "--input"].includes(name)),
);

// Comments, raw text and template contents are blanked to the same length, so a tag written inside
// a script or a comment is never taken for the page's own `<head>`.
const blankRawText = (html: string): string =>
  html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|template|noscript|iframe|noembed|noframes)\b[\s\S]*?(?:<\/\1\s*>|$)/gi,
    (match) => " ".repeat(match.length),
  );

/** `JSON.stringify` that's safe inside a `<script>`. */
const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c");

/**
 * The full document for an artifact: the agent's fragment or document with Cerium's head put in
 * first, so the theme, base styles and runtime are in place before the page's own.
 */
export const artifactDocument = (
  html: string,
  options: {
    readonly theme: ArtifactTheme;
    /** `@font-face` rules for the app's fonts (`fontFaces`); without them, the system's. */
    readonly fonts?: string | undefined;
    /** The frozen building blocks' stylesheet, for legacy artifacts (`isLegacyArtifact`). */
    readonly legacyCss?: string | undefined;
    /** A page of its own, outside the conversation (`STANDALONE_CSS`), titled `title` if it has none. */
    readonly standalone?: boolean | undefined;
    readonly title?: string | undefined;
  },
): string => {
  const legacy = options.legacyCss !== undefined && isLegacyArtifact(html);
  const runtime: RuntimeOptions = {
    prefix: MESSAGE_PREFIX,
    mode: options.theme.mode,
    variables: options.theme.variables,
    legacy,
  };
  const head = [
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_POLICY}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="cerium-theme">${themeUpdate(options.theme, legacy).css}</style>`,
    `<style id="cerium-base">${options.fonts ?? ""}\n${BASE_CSS}${options.standalone ? `\n${STANDALONE_CSS}` : ""}${legacy ? `\n${options.legacyCss}` : ""}</style>`,
    `<script>(${artifactRuntime.toString()})(${scriptJson(runtime)});</script>`,
  ];
  const scan = blankRawText(html);
  if (options.title !== undefined && !/<title[\s>]/i.test(html)) {
    head.push(`<title>${escapeHtml(options.title)}</title>`);
  }
  return withHead(html, scan, head.join("\n"));
};

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);

/** `html` with `head` put in at the start of its own head, made if it has none. */
const withHead = (html: string, scan: string, head: string): string => {
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(scan);
  const prefix = doctype ? "" : "<!doctype html>";
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return `${prefix}${html.slice(0, at)}\n${head}\n${html.slice(at)}`;
  }
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${prefix}${html.slice(0, at)}<head>\n${head}\n</head>${html.slice(at)}`;
  }
  if (doctype) {
    const at = doctype[0].length;
    return `${html.slice(0, at)}<html><head>\n${head}\n</head>${html.slice(at)}`;
  }
  return `<!doctype html>\n<html><head>\n${head}\n</head>\n<body>\n${html}\n</body></html>`;
};

/**
 * The page an artifact's frame loads (served as `artifact.html` beside the app's index). It renders
 * the document the window sends it, once, and only when sandboxed: without the sandbox it would run
 * in the app's own origin, so another site framing it gets an empty page. Another site may frame it
 * sandboxed, but then renders only what that site sends: the page holds nothing of the app's.
 */
export const artifactHostPage = (): string => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_POLICY}">
<script>
if (self.origin === "null" && window.parent !== window) {
  addEventListener("message", function (event) {
    var data = event.data;
    // The window around the frame, or the app that opened that window: a tab the app opens for an
    // artifact is driven by the app's own code.
    var trusted = event.source === window.parent || (window.parent.opener !== null && event.source === window.parent.opener);
    if (!trusted || !data || data.type !== ${JSON.stringify(RENDER_MESSAGE)} || typeof data.html !== "string") return;
    document.open();
    document.write(data.html);
    document.close();
  });
  window.parent.postMessage({ type: ${JSON.stringify(`${MESSAGE_PREFIX}ready`)} }, "*");
}
</script>
</head>
<body></body>
</html>
`;
