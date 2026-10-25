import { ARTIFACT_LANGUAGE } from "@cerium/artifacts";
import { mentionToken, type Mention } from "@cerium/protocol";
import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import {
  defaultComponents,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  Streamdown,
  type DefaultComponents,
} from "streamdown";

import { Artifact } from "./Artifact.tsx";
import { FileChip, SkillChip } from "./FileChip.tsx";
import { LINK_ATTRIBUTE } from "./menus.ts";
import { pathReference } from "./paths.ts";

/** Copy for code and tables; downloads don't earn a place in a conversation. */
const controls = {
  code: { copy: true, download: false },
  table: { copy: true, download: false, fullscreen: true },
  image: { download: false },
} as const;

/**
 * While a reply streams, each word comes in as ink (`sd-ink` in app.css), in the order it was
 * written; what's already shown stays still. A reply that isn't streaming renders plain.
 */
const ink = { animation: "ink", duration: 620, easing: "cubic-bezier(0.22, 0.8, 0.24, 1)", stagger: 22 };

/** Agents' HTML visuals arrive as code fences in this language. */
const plugins = { renderers: [{ language: ARTIFACT_LANGUAGE, component: Artifact }] };

/** The mentions of the message being rendered, by the token its text carries. */
const Mentions = createContext<ReadonlyMap<string, Mention>>(new Map());

/** Inside a link, which renders as a button: a chip there would be a button in a button. */
const InLink = createContext(false);

/**
 * Inline code that names a mention, a file or a folder shows as its chip; anything else, and code a
 * link wraps, as code.
 */
function InlineCode({ children, node: _node, ...props }: ComponentProps<"code"> & { node?: unknown }) {
  const mentions = useContext(Mentions);
  const inLink = useContext(InLink);
  const text = typeof children === "string" && !inLink ? children : undefined;
  const mention = text === undefined ? undefined : mentions.get(text);
  if (mention?._tag === "SkillMention") return <SkillChip name={mention.name} />;
  if (mention?._tag === "FileMention") return <FileChip path={mention.path} folder={mention.folder} />;
  const reference = text === undefined ? undefined : pathReference(text);
  if (reference) return <FileChip {...reference} />;
  return (
    <code data-streamdown="inline-code" {...props}>
      {children}
    </code>
  );
}

const StreamdownLink = defaultComponents.a;

/**
 * Streamdown's link, which asks before opening and so renders as a button without the address. The
 * address goes on a wrapper for the message menu's link items.
 */
function Link(props: ComponentProps<typeof StreamdownLink>) {
  const { href } = props;
  return (
    <span
      className="contents"
      {...(href && !href.startsWith("streamdown:") ? { [LINK_ATTRIBUTE]: href } : {})}
    >
      <InLink.Provider value>
        <StreamdownLink {...props} />
      </InLink.Provider>
    </span>
  );
}

const components = { inlineCode: InlineCode, a: Link };

interface MarkdownNode {
  type: string;
  value?: string;
  children?: Array<MarkdownNode>;
}

/** Text as the user typed it: every newline outside code is a line break, not a soft wrap. */
const remarkTypedBreaks = () => (tree: MarkdownNode) => {
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

const agentRemarkPlugins = Object.values(defaultRemarkPlugins);
const userRemarkPlugins = [...agentRemarkPlugins, remarkTypedBreaks];

interface HtmlNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Array<HtmlNode>;
}

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

/**
 * Rewrites each image's and link's address through `resolve` once sanitizing has run and before
 * hardening does, which blocks a bare relative path such as `media/shot.png` and collapses `../`
 * against a dummy root.
 */
const rehypeFolderAddresses =
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

const { harden, ...beforeHarden } = defaultRehypePlugins;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Wraps each mention's token in backticks, so markdown leaves it whole and it renders as its chip. */
const markMentions = (text: string, tokens: ReadonlyArray<string>): string => {
  const usable = tokens.filter((token) => !token.includes("`"));
  if (usable.length === 0) return text;
  const pattern = new RegExp(
    usable
      .toSorted((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join("|"),
    "g",
  );
  return text.replace(pattern, (token) => `\`${token}\``);
};

/** A reference link's definition (`[docs]: https://…`), which the links using it need in the same block. */
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:/m;

/** Agent-written markdown, or the user's own message. Streamdown completes unterminated syntax while text streams and sanitizes it. */
export function Markdown({
  text,
  streaming,
  compact = false,
  user,
  folder,
}: {
  text: string;
  streaming: boolean;
  /** Smaller type for markdown nested inside another block, such as a child agent's report. */
  compact?: boolean;
  /** The user's own message: line breaks kept as typed, and what they tagged shown as chips. */
  user?: { readonly mentions: ReadonlyArray<Mention> };
  /**
   * A file's Markdown, whose images and links point at files beside it: `resolve` turns each address
   * into the one `image` and `link` receive.
   */
  folder?: {
    readonly resolve: (address: string) => string | undefined;
    readonly image: DefaultComponents["img"];
    /** Draws a link to a file beside it; undefined leaves any other link as it is. */
    readonly link: (props: ComponentProps<typeof StreamdownLink>) => ReactNode | undefined;
  };
}) {
  const mentions = new Map((user?.mentions ?? []).map((mention) => [mentionToken(mention), mention]));
  // Rendered block by block, as a reply streams, and still once it's complete: rendering the whole
  // text at once instead parsed every block of it again and rebuilt them all as the reply finished
  // (about 4 ms a kilobyte, with its artifacts drawn again). Text with a reference link's definition
  // renders whole, so its links find it.
  const byBlock = streaming || !REFERENCE_DEFINITION.test(text);
  return (
    <Mentions value={mentions}>
      <Streamdown
        mode={byBlock ? "streaming" : "static"}
        isAnimating={streaming}
        animated={ink}
        parseIncompleteMarkdown={streaming}
        controls={controls}
        plugins={plugins}
        components={
          folder
            ? {
                ...components,
                img: folder.image,
                a: (props: ComponentProps<typeof StreamdownLink>) =>
                  folder.link(props) ?? <Link {...props} />,
              }
            : components
        }
        remarkPlugins={user ? userRemarkPlugins : agentRemarkPlugins}
        {...(folder
          ? {
              rehypePlugins: [
                ...Object.values(beforeHarden),
                rehypeFolderAddresses(folder.resolve),
                ...(harden ? [harden] : []),
              ],
            }
          : {})}
        lineNumbers={false}
        className={`${compact ? "text-[13px] leading-[1.6] text-fg-secondary [&>*+*]:mt-2.5" : "text-[14px] leading-[1.65] text-fg-primary [&>*+*]:mt-3"} [&_code]:font-mono [&_strong]:font-semibold [&_strong]:text-fg-primary`}
      >
        {user ? markMentions(text, [...mentions.keys()]) : text}
      </Streamdown>
    </Mentions>
  );
}
