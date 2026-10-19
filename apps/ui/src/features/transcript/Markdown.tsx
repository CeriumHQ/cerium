import { ARTIFACT_LANGUAGE } from "@cerium/artifacts";
import { mentionToken, type Mention } from "@cerium/protocol";
import { createContext, useContext, type ComponentProps } from "react";
import { defaultComponents, defaultRemarkPlugins, Streamdown, type DefaultComponents } from "streamdown";

import { Artifact } from "./Artifact.tsx";
import { FileChip, SkillChip } from "./FileChip.tsx";
import { LINK_ATTRIBUTE } from "./menus.ts";
import { pathReference } from "./paths.ts";

/** Copy for code and tables; downloads don't earn a place in a conversation. */
const controls = {
  code: { copy: true, download: false },
  table: { copy: true, download: false, fullscreen: true },
} as const;

/** Agents' HTML visuals arrive as code fences in this language. */
const plugins = { renderers: [{ language: ARTIFACT_LANGUAGE, component: Artifact }] };

/** The mentions of the message being rendered, by the token its text carries. */
const Mentions = createContext<ReadonlyMap<string, Mention>>(new Map());

/** Inline code that names a mention, a file or a folder shows as its chip; anything else as code. */
function InlineCode({ children, node: _node, ...props }: ComponentProps<"code"> & { node?: unknown }) {
  const mentions = useContext(Mentions);
  const text = typeof children === "string" ? children : undefined;
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
      <StreamdownLink {...props} />
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

/** Agent-written markdown, or the user's own message. Streamdown completes unterminated syntax while text streams and sanitizes it. */
export function Markdown({
  text,
  streaming,
  compact = false,
  user,
  image,
}: {
  text: string;
  streaming: boolean;
  /** Smaller type for markdown nested inside another block, such as a child agent's report. */
  compact?: boolean;
  /** The user's own message: line breaks kept as typed, and what they tagged shown as chips. */
  user?: { readonly mentions: ReadonlyArray<Mention> };
  /** Draws images itself: a file's Markdown reads the ones beside it from its folder. */
  image?: DefaultComponents["img"];
}) {
  const mentions = new Map((user?.mentions ?? []).map((mention) => [mentionToken(mention), mention]));
  return (
    <Mentions value={mentions}>
      <Streamdown
        mode={streaming ? "streaming" : "static"}
        isAnimating={streaming}
        controls={controls}
        plugins={plugins}
        components={image ? { ...components, img: image } : components}
        remarkPlugins={user ? userRemarkPlugins : agentRemarkPlugins}
        lineNumbers={false}
        className={`${compact ? "text-[13px] leading-[1.6] text-fg-secondary [&>*+*]:mt-2.5" : "text-[14px] leading-[1.65] text-fg-primary [&>*+*]:mt-3"} [&_code]:font-mono [&_strong]:font-semibold [&_strong]:text-fg-primary`}
      >
        {user ? markMentions(text, [...mentions.keys()]) : text}
      </Streamdown>
    </Mentions>
  );
}
