// The addresses Cerium's preview opens: web pages over http and https, nothing else. Plain functions
// with no Node or DOM of their own, so the UI's address bar, the desktop shell and the agents' tools
// read an address the same way.

/** Hosts a dev server answers on, which an address without a scheme opens over plain http. */
const LOCAL = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i;

/**
 * What the user or an agent typed as the URL the preview opens: `localhost:5173` and `127.0.0.1:3000/x`
 * over http, `example.com` over https, and http or https URLs as they are. Undefined for anything
 * else, a `file:` or `javascript:` URL among them.
 */
export const previewUrl = (input: string): string | undefined => {
  const text = input.trim();
  if (text === "") return undefined;
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(text);
  const candidate = hasScheme ? text : `${LOCAL.test(text) ? "http" : "https"}://${text}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.hostname === "") return undefined;
    // `0.0.0.0` is where a dev server listens, not where a browser reaches it.
    if (url.hostname === "0.0.0.0") url.hostname = "localhost";
    return url.href;
  } catch {
    return undefined;
  }
};

/** Whether `url` may load in the preview: http or https alone. */
export const isPreviewable = (url: string): boolean => /^https?:\/\//i.test(url);

/** Whether `url` is a page on this computer, as a dev server serves it. */
export const isLocalUrl = (url: string): boolean => {
  try {
    const { protocol, host } = new URL(url);
    return (protocol === "http:" || protocol === "https:") && LOCAL.test(host);
  } catch {
    return false;
  }
};

/** Colours, cursor moves and window titles in terminal output. */
// oxlint-disable-next-line no-control-regex -- escape sequences are control characters
const ESCAPES = /\u001b\[[\d;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

/** Terminal output as the text it shows: a dev server colours its port apart from its host. */
export const withoutEscapes = (text: string): string => text.replace(ESCAPES, "");

/**
 * The local addresses in terminal output without its escapes (`withoutEscapes`), such as Vite's
 * `Local: http://localhost:5173/`. With `partial`, the text is the latest output, which can stop
 * partway through an address: one running to its very end waits for the output after it.
 */
export const localUrlsIn = (text: string, partial = false): ReadonlyArray<string> => {
  const found: Array<string> = [];
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s"'<>`]+/gi)) {
    if (partial && match.index + match[0].length === text.length) continue;
    const url = match[0].replace(/[.,;:)\]]+$/, "");
    const normalized = previewUrl(url);
    if (normalized !== undefined && isLocalUrl(normalized) && !found.includes(normalized)) {
      found.push(normalized);
    }
  }
  return found;
};
