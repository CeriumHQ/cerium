// The remark and rehype plugins agent markdown renders through, beyond GitHub's own syntax: plain
// functions over the trees, so the tests can run them without React.

import { pathReference } from "./paths.ts";

interface MarkdownNode {
  type: string;
  value?: string;
  children?: Array<MarkdownNode>;
}

/** Text as the user typed it: every newline outside code is a line break, not a soft wrap. */
export const remarkTypedBreaks = () => (tree: MarkdownNode) => {
  const visit = (node: MarkdownNode) => {
    if (node.children === undefined) return;
    node.children = node.children.flatMap((child): Array<MarkdownNode> => {
      if (child.type !== "text" || child.value?.includes("\n") !== true) {
        visit(child);
        return [child];
      }
      return child.value
        .split("\n")
        .flatMap((line, index): Array<MarkdownNode> => [
          ...(index > 0 ? [{ type: "break" }] : []),
          ...(line === "" ? [] : [{ type: "text", value: line }]),
        ]);
    });
  };
  visit(tree);
};

/** A node of the markdown tree, as far as `remarkDollarGuard` reads it. */
interface MarkdownSpan extends MarkdownNode {
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/**
 * Inline `$…$` as Pandoc reads it, so prose about money stays prose: the opening `$` must be followed
 * by a non-space, the closing one preceded by a non-space and not followed by a digit. "costs $5 or
 * $6" and "$5-$6" are text; "$x^2$" is math. A `$$…$$` on one line is always math. What fails the
 * check turns back into the text it was written as.
 */
export const remarkDollarGuard = () => (tree: MarkdownSpan, file: { value: unknown }) => {
  const source = String(file.value);
  const visit = (node: MarkdownSpan) => {
    if (node.children === undefined) return;
    node.children = node.children.map((child: MarkdownSpan): MarkdownSpan => {
      if (child.type !== "inlineMath") {
        visit(child);
        return child;
      }
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;
      if (start === undefined || end === undefined) return child;
      const raw = source.slice(start, end);
      if (raw.startsWith("$$")) return child;
      // The node's own value is trimmed, so the spaces are read off the source.
      const inner = raw.slice(1, -1);
      const plain = /^\s/.test(inner) || /\s$/.test(inner) || /\d/.test(source[end] ?? "");
      return plain ? { type: "text", value: raw } : child;
    });
  };
  visit(tree);
};

/** A node of the HTML tree markdown becomes, as far as these plugins and the components read it. */
export interface HtmlNode {
  type: string;
  tagName?: string | undefined;
  value?: string | undefined;
  properties?: Record<string, unknown> | undefined;
  children?: Array<HtmlNode> | undefined;
  position?: { start: { offset?: number | undefined } } | undefined;
}

/** The kinds of GitHub's alerts (`> [!NOTE]`), which agents write for asides that matter. */
export const ALERTS = ["note", "tip", "important", "warning", "caution"] as const;
export type AlertKind = (typeof ALERTS)[number];

const ALERT_MARK = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i;

/**
 * A blockquote that opens with `[!NOTE]` (or another of GitHub's alert kinds) as an alert: the mark
 * comes off its text and its kind goes on the quote as `data-alert`, for the blockquote component.
 */
export const rehypeAlerts = () => (tree: HtmlNode) => {
  const visit = (node: HtmlNode) => {
    node.children?.forEach(visit);
    if (node.tagName !== "blockquote") return;
    const paragraph = node.children?.find((child) => child.type === "element");
    const first = paragraph?.tagName === "p" ? paragraph.children?.[0] : undefined;
    const match = first?.type === "text" ? ALERT_MARK.exec(first.value ?? "") : null;
    if (!match || !first || !paragraph) return;
    first.value = first.value!.slice(match[0].length);
    // A line break straight after the mark is the paragraph's own first line ending.
    const next = paragraph.children?.[1];
    if (first.value === "" && next?.tagName === "br") paragraph.children!.splice(0, 2);
    else if (first.value === "") paragraph.children!.splice(0, 1);
    if (paragraph.children!.every((child) => child.type === "text" && child.value!.trim() === "")) {
      node.children = node.children!.filter((child) => child !== paragraph);
    }
    node.properties = {
      ...node.properties,
      dataAlert: match[1]!.toLowerCase(),
    };
  };
  visit(tree);
};

/** The first address in a `srcset`. */
const firstSource = (srcset: unknown): string | undefined => {
  const first = Array.isArray(srcset) ? srcset[0] : srcset;
  return typeof first === "string" ? first.trim().split(/[\s,]/)[0] || undefined : undefined;
};

/** A `<picture>` as the one image the current colour scheme picks, drawn by the image component. */
const choosePicture = (picture: HtmlNode) => {
  const children = picture.children ?? [];
  const chosen = children.find((child) => {
    if (child.tagName !== "source") return false;
    const media = child.properties?.["media"];
    return typeof media !== "string" || matchMedia(media).matches;
  });
  const src = chosen && firstSource(chosen.properties?.["srcSet"]);
  picture.children = children.filter((child) => child.tagName !== "source");
  const image = picture.children.find((child) => child.tagName === "img");
  if (src !== undefined && image) image.properties = { ...image.properties, src };
};

/** The property an image the agent named by its path on disk carries that path in (`data-local-path`). */
export const LOCAL_PATH = "dataLocalPath";

/**
 * The file an image's address names on the backend's machine: an absolute path (`/tmp/a.png`,
 * `C:\a.png`) or a `file://` URL. Undefined for a web address, a protocol-relative `//host/…`, or a
 * relative one.
 */
export const localImagePath = (address: string): string | undefined => {
  if (/^file:/i.test(address)) {
    let path = address.replace(/^file:(?:\/\/(?:localhost)?)?/i, "");
    try {
      path = decodeURIComponent(path);
    } catch {
      // Left as written.
    }
    path = path.replace(/^\/(?=[a-z]:[\\/])/i, "");
    return /^(?:[a-z]:[\\/]|\/(?!\/))/i.test(path) ? path : undefined;
  }
  return /^(?:[a-z]:[\\/]|\/(?![\\/]))/i.test(address) ? address : undefined;
};

/**
 * Each image whose address is a file on disk, with that path moved to `LOCAL_PATH`, for the image
 * component to read through the backend. Left as an address, a path would be fetched from wherever
 * the window was served (on a phone over remote access, the relay), and a `file:` or drive address
 * would be dropped by the sanitizer. Runs before it, and after `rehypeRaw`, so `<img>` tags count too.
 */
export const rehypeLocalImages = () => (tree: HtmlNode) => {
  const visit = (node: HtmlNode) => {
    const src = node.tagName === "img" ? node.properties?.["src"] : undefined;
    const path = typeof src === "string" ? localImagePath(src) : undefined;
    if (path !== undefined) {
      const { src: _src, ...rest } = node.properties ?? {};
      node.properties = { ...rest, [LOCAL_PATH]: path };
    }
    node.children?.forEach(visit);
  };
  visit(tree);
};

/** The property a preview of an image file the agent named (`rehypeImageReferences`) carries its path in. */
export const IMAGE_REFERENCE = "dataImageReference";

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|bmp|avif|svg)$/i;

/** The image file inline code or a link names, as written (maybe relative); undefined for anything else. */
const referencedImage = (node: HtmlNode): string | undefined => {
  let path: string | undefined;
  if (node.tagName === "code") {
    const className = node.properties?.["className"];
    if (Array.isArray(className) && className.length > 0) return undefined;
    const text = node.children?.length === 1 ? node.children[0] : undefined;
    path = text?.type === "text" ? pathReference(text.value ?? "")?.path : undefined;
  } else if (node.tagName === "a") {
    const href = node.properties?.["href"];
    if (typeof href !== "string") return undefined;
    if (/^file:/i.test(href)) path = localImagePath(href);
    else if (!/^[a-z][a-z\d+.-]*:|^#|^\/\//i.test(href)) {
      try {
        path = pathReference(decodeURI(href))?.path;
      } catch {
        path = undefined;
      }
    }
  }
  return path !== undefined && IMAGE_FILE.test(path) ? path : undefined;
};

/**
 * A preview of each image file a paragraph or list item names in inline code or a link, under its
 * line: agents cite their screenshots as `/tmp/after.png` far more often than as `![](…)`, and a
 * chip alone hides what it shows. The chip stays where it was written; an image the block already
 * shows isn't shown twice.
 */
export const rehypeImageReferences = () => (tree: HtmlNode) => {
  const collect = (node: HtmlNode, found: Array<string>, shown: Set<string>) => {
    for (const child of node.children ?? []) {
      // A nested list or paragraph previews its own.
      if (child.tagName === "ul" || child.tagName === "ol" || child.tagName === "p") continue;
      if (child.tagName === "img") {
        const path = child.properties?.[LOCAL_PATH] ?? child.properties?.["src"];
        if (typeof path === "string") shown.add(path);
        continue;
      }
      const path = referencedImage(child);
      if (path !== undefined) {
        if (!found.includes(path)) found.push(path);
        continue;
      }
      collect(child, found, shown);
    }
  };
  const previews = (node: HtmlNode): Array<HtmlNode> => {
    const found: Array<string> = [];
    const shown = new Set<string>();
    collect(node, found, shown);
    return found
      .filter((path) => !shown.has(path))
      .map((path) => ({
        type: "element",
        tagName: "img",
        properties: { [IMAGE_REFERENCE]: path },
        children: [],
      }));
  };
  const visit = (node: HtmlNode) => {
    node.children?.forEach(visit);
    if (node.children === undefined) return;
    node.children = node.children.flatMap((child): Array<HtmlNode> => {
      if (child.tagName !== "p") return [child];
      const images = previews(child);
      return images.length === 0 ? [child] : [child, { type: "element", tagName: "p", children: images }];
    });
    if (node.tagName === "li") {
      const images = previews(node);
      if (images.length === 0) return;
      // Under the item's own line, above any list nested in it.
      const nested = node.children.findIndex((child) => child.tagName === "ul" || child.tagName === "ol");
      const at = nested === -1 ? node.children.length : nested;
      node.children.splice(at, 0, {
        type: "element",
        tagName: "div",
        children: images,
      });
    }
  };
  visit(tree);
};

/** Which attribute of an element holds the address `resolve` rewrites. */
const ADDRESSES: Readonly<Record<string, string>> = { img: "src", a: "href" };

/** Rewrites each image's and link's address through `resolve`, for a file's markdown beside its files. */
export const rehypeFolderAddresses =
  (resolve: (address: string) => string | undefined) => () => (tree: HtmlNode) => {
    const visit = (node: HtmlNode) => {
      if (node.tagName === "picture") choosePicture(node);
      const attribute = node.tagName === undefined ? undefined : ADDRESSES[node.tagName];
      const address = attribute === undefined ? undefined : node.properties?.[attribute];
      if (attribute !== undefined && typeof address === "string") {
        const resolved = resolve(address);
        if (resolved !== undefined) node.properties = { ...node.properties, [attribute]: resolved };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };

/** Elements whose text isn't prose: their words don't ink in one by one. */
const NOT_PROSE = new Set(["pre", "code", "svg", "math"]);

/** How far apart a batch's new words start, and the most a batch's last word waits. */
const INK_STAGGER = 22;
const INK_SPREAD = 260;

/**
 * Each word of prose as a span that inks in (`.ink`, markdown.css) as it first appears. Words from
 * `from` on (an offset into the block's source) are the batch just written: each starts a little
 * after the one before, so the batch writes itself out in reading order. Words before it keep their
 * span, already inked, so a word mid-animation isn't cut short and none plays again.
 */
export const rehypeInk = (from: number) => () => (tree: HtmlNode) => {
  let fresh = 0;
  const visit = (node: HtmlNode) => {
    if (node.tagName !== undefined && NOT_PROSE.has(node.tagName)) return;
    node.children = node.children?.flatMap((child): Array<HtmlNode> => {
      if (child.type !== "text") {
        visit(child);
        return [child];
      }
      const text = child.value ?? "";
      const start = child.position?.start.offset ?? 0;
      let offset = 0;
      return text.split(/(\s+)/).flatMap((part): Array<HtmlNode> => {
        const at = start + offset;
        offset += part.length;
        if (part === "") return [];
        if (/^\s+$/.test(part)) return [{ type: "text", value: part }];
        const delay = at >= from ? Math.min(fresh++ * INK_STAGGER, INK_SPREAD) : 0;
        return [
          {
            type: "element",
            tagName: "span",
            properties: {
              className: ["ink"],
              style: `animation-delay:${delay}ms`,
            },
            children: [{ type: "text", value: part }],
          },
        ];
      });
    });
  };
  visit(tree);
};
