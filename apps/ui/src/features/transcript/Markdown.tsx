import { mentionToken, type Mention } from "@cerium/protocol";
import { memo, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema, type Options as Schema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { PluggableList } from "unified";

import { closeOpenSyntax, openFence, splitBlocks } from "./markdownBlocks.ts";
import {
  Link,
  Mentions,
  parts,
  Unfinished,
  type MarkdownImageProps,
  type MarkdownLinkProps,
} from "./MarkdownParts.tsx";
import {
  rehypeAlerts,
  rehypeFolderAddresses,
  rehypeInk,
  remarkDollarGuard,
  remarkTypedBreaks,
} from "./markdownPlugins.ts";

export type { MarkdownImageProps, MarkdownLinkProps } from "./MarkdownParts.tsx";

/** A file's Markdown, whose images and links point at files beside it. */
export interface MarkdownFolder {
  /** Turns each image's and link's address into the one `image` and `link` receive. */
  readonly resolve: (address: string) => string | undefined;
  readonly image: (props: MarkdownImageProps) => ReactNode;
  /** Draws a link to a file beside it; undefined leaves any other link as it is. */
  readonly link: (props: MarkdownLinkProps) => ReactNode | undefined;
}

/**
 * HTML an agent writes is kept to what GitHub would show: the sanitizer's own list, which drops
 * scripts, styles, frames, forms and event handlers. Math keeps the classes that tell its inline
 * form from its display form.
 */
const schema: Schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
  },
};
const sanitize: PluggableList = [rehypeRaw, [rehypeSanitize, schema]];

const agentRemark: PluggableList = [remarkGfm, remarkMath, remarkDollarGuard];
const userRemark: PluggableList = [remarkGfm, remarkTypedBreaks];

/** A reference link's definition (`[docs]: https://…`), which the links using it need in the same block. */
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:/m;

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

/**
 * One top-level block: a paragraph, a list, a code block, a table. It renders again only when its
 * own text changes, so while a reply streams only its last block does; this is why replies are cut
 * into blocks at all (rendering the whole reply for every streamed word cost about 4 ms a
 * kilobyte, with its artifacts drawn again).
 */
const Block = memo(function Block({
  source,
  writing,
  ink,
  user,
  folder,
}: {
  source: string;
  /** The block the agent is writing now: its open marks are closed, and an open fence stays open. */
  writing: boolean;
  /** Its words ink in as they arrive. */
  ink: boolean;
  /** The user's own message, whose line breaks are kept as typed. */
  user: boolean;
  folder: MarkdownFolder | undefined;
}) {
  // Where this block's text stood when it last rendered: what comes after it just arrived.
  const [seen, setSeen] = useState({ source, from: writing ? 0 : source.length });
  if (seen.source !== source) {
    setSeen({ source, from: source.startsWith(seen.source) ? seen.source.length : 0 });
  }
  const rehypePlugins: PluggableList = [
    ...sanitize,
    rehypeAlerts,
    ...(folder ? [rehypeFolderAddresses(folder.resolve)] : []),
    ...(ink ? [rehypeInk(seen.from)] : []),
  ];
  const components: Components = folder
    ? {
        ...parts,
        img: folder.image,
        a: (props) => folder.link(props) ?? <Link {...props} />,
      }
    : parts;
  return (
    <Unfinished value={writing && openFence(source)}>
      <ReactMarkdown
        remarkPlugins={user ? userRemark : agentRemark}
        rehypePlugins={rehypePlugins}
        remarkRehypeOptions={{ allowDangerousHtml: true }}
        components={components}
        urlTransform={defaultUrlTransform}
      >
        {writing ? closeOpenSyntax(source) : source}
      </ReactMarkdown>
    </Unfinished>
  );
});

/**
 * Agent-written markdown, or the user's own message. While it streams, the block being written has
 * its unterminated syntax closed, and each new word inks in.
 */
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
  /** A file's Markdown, whose images and links point at files beside it. */
  folder?: MarkdownFolder;
}) {
  // A reply that streamed in while it was on screen keeps its words' spans once it's done, so
  // finishing doesn't draw it all again.
  const [ink] = useState(streaming);
  const mentions = new Map((user?.mentions ?? []).map((mention) => [mentionToken(mention), mention]));
  const source = user ? markMentions(text, [...mentions.keys()]) : text;
  // Text with a reference link's definition renders whole, so its links find it.
  const blocks = streaming || !REFERENCE_DEFINITION.test(source) ? splitBlocks(source) : [source];
  return (
    <Mentions value={mentions}>
      <div data-md="root" className={compact ? "md md-compact" : "md"}>
        {blocks.map((block, index) => (
          <Block
            key={index}
            source={block}
            writing={streaming && index === blocks.length - 1}
            ink={ink}
            user={user !== undefined}
            folder={folder}
          />
        ))}
      </div>
    </Mentions>
  );
}
