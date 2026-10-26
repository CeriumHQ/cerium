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

/** The local addresses in a line of terminal output, such as Vite's `Local: http://localhost:5173/`. */
export const localUrlsIn = (text: string): ReadonlyArray<string> => {
  const found: Array<string> = [];
  // Terminal colours split a URL from its port at times; they're gone before this sees the text.
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s"'<>`]+/gi)) {
    const url = match[0].replace(/[.,;:)\]]+$/, "");
    const normalized = previewUrl(url);
    if (normalized !== undefined && isLocalUrl(normalized) && !found.includes(normalized)) {
      found.push(normalized);
    }
  }
  return found;
};
