import stylesheet from "@cerium/artifacts/artifact.css?raw";
import geistMono from "@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?inline";
import geist from "@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?inline";

// The document an artifact renders as. It runs in a sandboxed frame with an opaque origin, so its
// policy blocks every network request and every script but Cerium's own runtime: an agent's HTML
// can lay itself out but never run code, fetch anything or reach the app.

/** The message the runtime posts whenever the artifact's height changes. */
export const HEIGHT_MESSAGE = "cerium-artifact:height";

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
@font-face { font-family: "Geist Variable"; font-weight: 100 900; font-display: block; src: url(${geist}) format("woff2"); }
@font-face { font-family: "Geist Mono Variable"; font-weight: 100 900; font-display: block; src: url(${geistMono}) format("woff2"); }`;

/**
 * Runs inside the frame: turns `.tabs` sections into tabs, keeps links from navigating the frame and
 * reports the content's height to the transcript. Serialized into the document, so it must not
 * reference anything outside itself.
 */
function artifactRuntime(message: string) {
  let group = 0;
  for (const tabs of document.querySelectorAll<HTMLElement>(".tabs")) {
    const sections = [...tabs.children].filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child.tagName === "SECTION",
    );
    if (sections.length === 0) continue;
    group++;
    const list = document.createElement("div");
    list.className = "tablist";
    list.setAttribute("role", "tablist");
    const buttons = sections.map((section, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.id = `tab-${group}-${index}`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", `panel-${group}-${index}`);
      button.append(section.dataset["tab"] ?? `Tab ${index + 1}`);
      section.id = `panel-${group}-${index}`;
      section.setAttribute("role", "tabpanel");
      section.setAttribute("aria-labelledby", button.id);
      return button;
    });
    const select = (selected: number) => {
      buttons.forEach((button, index) => {
        button.setAttribute("aria-selected", String(index === selected));
        button.tabIndex = index === selected ? 0 : -1;
        sections[index]!.hidden = index !== selected;
      });
    };
    buttons.forEach((button, index) => button.addEventListener("click", () => select(index)));
    list.addEventListener("keydown", (event) => {
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (current < 0 || step === undefined) return;
      const next = (current + step + buttons.length) % buttons.length;
      select(next);
      buttons[next]!.focus();
      event.preventDefault();
    });
    list.append(...buttons);
    tabs.prepend(list);
    select(0);
  }

  document.addEventListener(
    "click",
    (event) => {
      if (event.target instanceof Element && event.target.closest("a")) event.preventDefault();
    },
    true,
  );

  const report = () =>
    parent.postMessage(
      { type: message, height: Math.ceil(document.documentElement.getBoundingClientRect().height) },
      "*",
    );
  new ResizeObserver(report).observe(document.documentElement);
}

/**
 * The full `srcdoc` for a sanitized artifact body, in the window's current theme. The nonce admits
 * the runtime alone; keep it stable per artifact so re-renders don't reload the frame.
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
<script nonce="${nonce}">(${artifactRuntime.toString()})(${JSON.stringify(HEIGHT_MESSAGE)});</script>
</body>
</html>`;
};
