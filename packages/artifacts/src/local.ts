// Local files in an artifact: a page names a file on the machine by its absolute path, in an
// attribute, a CSS `url()` or a script's string, and the file's bytes take the path's place, as a
// `data:` URL, before the page renders. The page itself can never load a local file. Images may be
// anywhere; data files (CSV, TSV, JSON) only in the thread's folder, since a page can send what it
// holds anywhere on the web.

export type LocalFileKind = "image" | "data";

const TYPES: Readonly<Record<string, { readonly kind: LocalFileKind; readonly mediaType: string }>> = {
  png: { kind: "image", mediaType: "image/png" },
  jpg: { kind: "image", mediaType: "image/jpeg" },
  jpeg: { kind: "image", mediaType: "image/jpeg" },
  gif: { kind: "image", mediaType: "image/gif" },
  webp: { kind: "image", mediaType: "image/webp" },
  svg: { kind: "image", mediaType: "image/svg+xml" },
  avif: { kind: "image", mediaType: "image/avif" },
  bmp: { kind: "image", mediaType: "image/bmp" },
  ico: { kind: "image", mediaType: "image/x-icon" },
  csv: { kind: "data", mediaType: "text/csv" },
  tsv: { kind: "data", mediaType: "text/tab-separated-values" },
  json: { kind: "data", mediaType: "application/json" },
  geojson: { kind: "data", mediaType: "application/geo+json" },
  jsonl: { kind: "data", mediaType: "application/jsonl" },
  ndjson: { kind: "data", mediaType: "application/x-ndjson" },
};

/** What a local file is to a page, by extension: an image or data, and its media type. */
export const localFileType = (file: string) => TYPES[file.split(".").at(-1)?.toLowerCase() ?? ""];

/** The most a data file may hold to be embedded, as the app reads one for its viewer. */
export const MAX_DATA_BYTES = 2 * 1024 * 1024;

/** A data file's text as the `data:` URL a page reads it from, with `fetch` like any other. */
export const dataFileUrl = (mediaType: string, text: string): string => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return `data:${mediaType};charset=utf-8;base64,${btoa(binary)}`;
};

const EXTENSION = Object.keys(TYPES).join("|");
/** The start of an absolute path: `file://`, a drive (`C:\`, `C:/`) or `/`, but not `//` or `/*`. */
const ROOT = String.raw`(?:file:\/\/\/?)?(?:[A-Za-z]:[\\/]|\/(?![\/*]))`;

/** A whole quoted string that is a file's path: an attribute's value or a script's string. */
const quoted = () => new RegExp(String.raw`(["'\x60])(${ROOT}[^"'\x60<>\n]*?\.(?:${EXTENSION}))\1`, "gi");
/** An unquoted CSS `url(…)`. */
const bare = () => new RegExp(String.raw`(url\(\s*)(${ROOT}[^)"'\s]*?\.(?:${EXTENSION}))(\s*\))`, "gi");

/** The file a path written in a page names: without `file://`, with a script's doubled backslashes undone. */
const fileOf = (written: string): string => {
  if (/^file:/i.test(written)) {
    let path = written.replace(/^file:\/\/\/?/i, "");
    try {
      path = decodeURIComponent(path);
    } catch {
      // Left as written.
    }
    return /^[A-Za-z]:/.test(path) ? path : `/${path}`;
  }
  return written.replace(/\\\\/g, "\\");
};

/** The local files a page names, each once. */
export const localFiles = (html: string): ReadonlyArray<string> => {
  const files = new Set<string>();
  for (const match of html.matchAll(quoted())) files.add(fileOf(match[2]!));
  for (const match of html.matchAll(bare())) files.add(fileOf(match[2]!));
  return [...files];
};

/** The page with each local file it names replaced by its `data:` URL in `urls`, by file. */
export const withLocalFiles = (html: string, urls: ReadonlyMap<string, string>): string => {
  if (urls.size === 0) return html;
  const swap = (written: string) => urls.get(fileOf(written));
  return html
    .replace(quoted(), (match, quote: string, written: string) => {
      const url = swap(written);
      return url === undefined ? match : `${quote}${url}${quote}`;
    })
    .replace(bare(), (match, open: string, written: string, close: string) => {
      const url = swap(written);
      return url === undefined ? match : `${open}${url}${close}`;
    });
};
