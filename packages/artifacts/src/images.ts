// Local images in an artifact: a page names a file on the machine by its absolute path, in an
// attribute, a CSS `url()` or a script's string, and the file's bytes take the path's place before the
// page renders. The page itself can never load a local file.

const EXTENSIONS: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

/** The media type of an image file, by extension. */
export const imageMediaType = (file: string): string | undefined =>
  EXTENSIONS[file.split(".").at(-1)?.toLowerCase() ?? ""];

const EXTENSION = Object.keys(EXTENSIONS).join("|");
/** The start of an absolute path: `file://`, a drive (`C:\`, `C:/`) or `/`, but not `//` or `/*`. */
const ROOT = String.raw`(?:file:\/\/\/?)?(?:[A-Za-z]:[\\/]|\/(?![\/*]))`;

/** A whole quoted string that is an image's path: an attribute's value or a script's string. */
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

/** The local image files a page names, each once. */
export const localImages = (html: string): ReadonlyArray<string> => {
  const files = new Set<string>();
  for (const match of html.matchAll(quoted())) files.add(fileOf(match[2]!));
  for (const match of html.matchAll(bare())) files.add(fileOf(match[2]!));
  return [...files];
};

/** The page with each local image it names replaced by its `data:` URL in `images`, by file. */
export const withLocalImages = (html: string, images: ReadonlyMap<string, string>): string => {
  if (images.size === 0) return html;
  const swap = (written: string) => images.get(fileOf(written));
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
