import stylesheet from "@cerium/artifacts/artifact.css?raw";
import redHatMono from "@fontsource-variable/red-hat-mono/files/red-hat-mono-latin-wght-normal.woff2?inline";
import redHatText from "@fontsource-variable/red-hat-text/files/red-hat-text-latin-wght-normal.woff2?inline";

// The document an artifact renders as. It runs in a sandboxed frame with an opaque origin, so its
// policy blocks every network request and every script but Cerium's own runtime: an agent's HTML
// can lay itself out but never run code, fetch anything or reach the app.

export { HEIGHT_MESSAGE } from "./artifactRuntime.ts";

/** Elements that could navigate, embed, submit or load something; the frame's policy is the backstop. */
const BLOCKED = "script, iframe, frame, frameset, object, embed, form, base, meta, link, portal";

/** An agent's HTML reduced to its body (plus any `<style>`), without blocked elements or handlers. */
export const sanitizeArtifact = (html: string): string => {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.body.prepend(...doc.head.querySelectorAll("style"));
  for (const element of doc.body.querySelectorAll(BLOCKED)) element.remove();
  for (const element of doc.body.querySelectorAll("*")) {
    for (const { name } of [...element.attributes]) {
      if (name.toLowerCase().startsWith("on")) element.removeAttribute(name);
    }
  }
  return doc.body.innerHTML;
};

/** Cerium's design tokens the stylesheet builds its vocabulary from. */
const hostTokens = [
  ...new Set(
    [
      ...stylesheet.matchAll(/var\((--(?:fg|line|surface|status|series)-[\w-]+|--selection|--focus-ring)/g),
    ].map((match) => match[1]!),
  ),
];

/** The window's current values for those tokens, so the artifact matches the theme on screen. */
const tokenValues = (): string => {
  const style = getComputedStyle(document.documentElement);
  return hostTokens.map((name) => `${name}: ${style.getPropertyValue(name).trim()};`).join(" ");
};

const fonts = `
@font-face { font-family: "Red Hat Text Variable"; font-weight: 300 700; font-display: block; src: url(${redHatText}) format("woff2"); }
@font-face { font-family: "Red Hat Mono Variable"; font-weight: 300 700; font-display: block; src: url(${redHatMono}) format("woff2"); }`;

/**
 * The full `srcdoc` for a sanitized artifact body, in the window's current theme. The nonce admits
 * the runtime alone; keep it stable per artifact so re-renders don't reload the frame. The web
 * client's policy, which the frame inherits, admits the runtime by its hash (vite.config.ts).
 */
export const artifactDocument = (body: string, theme: "dark" | "light", nonce: string): string => {
  const policy = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "font-src data:",
    "img-src data:",
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  return `<!doctype html>
<html data-theme="${theme}" style="color-scheme: ${theme}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<style>${fonts}
:root { ${tokenValues()} }
${stylesheet}</style>
</head>
<body>${body}
<script nonce="${nonce}">${__ARTIFACT_RUNTIME__}</script>
</body>
</html>`;
};
