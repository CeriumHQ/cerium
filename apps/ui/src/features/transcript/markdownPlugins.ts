// The remark and rehype plugins agent markdown renders through, beyond GitHub's own syntax: plain
// functions over the trees, so the tests can run them without React.

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
    node.properties = { ...node.properties, dataAlert: match[1]!.toLowerCase() };
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
            properties: { className: ["ink"], style: `animation-delay:${delay}ms` },
            children: [{ type: "text", value: part }],
          },
        ];
      });
    });
  };
  visit(tree);
};
