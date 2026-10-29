import { ARTIFACT_LANGUAGE } from "@cerium/artifacts";
import {
  Check,
  CircleAlert,
  Info,
  Lightbulb,
  MessageSquareWarning,
  OctagonAlert,
  type LucideIcon,
} from "lucide-react";
import { createContext, useContext, useState, type ComponentProps, type ReactNode } from "react";

import { FileIcon } from "../../components/FileIcon.tsx";
import { Tooltip } from "../../components/ui/Tooltip.tsx";
import { LineText } from "../viewer/CodeView.tsx";
import { useHighlight } from "../viewer/highlight.ts";
import { Artifact } from "./Artifact.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { FileChip, SkillChip } from "./FileChip.tsx";
import { Formula } from "./MarkdownMath.tsx";
import { Diagram } from "./MarkdownMermaid.tsx";
import type { AlertKind, HtmlNode } from "./markdownPlugins.ts";
import { isOpenableLink, LINK_ATTRIBUTE } from "./menus.ts";
import { pathReference } from "./paths.ts";
import type { Mention } from "@cerium/protocol";

// The elements agent markdown is drawn with: every one Cerium's own, styled through the design
// tokens (markdown.css lays out the prose between them).

/** What react-markdown hands each element beside its own attributes: the tree node it came from. */
type Part<Tag extends keyof React.JSX.IntrinsicElements> = ComponentProps<Tag> & {
  node?: HtmlNode | undefined;
};

/** The mentions of the message being rendered, by the token its text carries. */
export const Mentions = createContext<ReadonlyMap<string, Mention>>(new Map());

/** Inside a link: a chip there would be a button in a button. */
const InLink = createContext(false);

/** The block is still being written, so its last code fence may not be closed yet. */
export const Unfinished = createContext(false);

/** The text inside a tree node, as it reads. */
const textOf = (node: HtmlNode | undefined): string =>
  node === undefined
    ? ""
    : node.type === "text"
      ? (node.value ?? "")
      : (node.children ?? []).map(textOf).join("");

/**
 * Inline code that names a mention, a file or a folder shows as its chip; anything else, and code a
 * link wraps, as code.
 */
export function InlineCode({ children, node: _node, ...props }: Part<"code">) {
  const mentions = useContext(Mentions);
  const inLink = useContext(InLink);
  const unfinished = useContext(Unfinished);
  if (typeof children === "string" && props.className?.split(" ").includes("math-inline")) {
    return (
      <Formula
        source={children}
        display={false}
        unfinished={unfinished}
        fallback={<code data-md="inline-code">{`$${children}$`}</code>}
      />
    );
  }
  const text = typeof children === "string" && !inLink ? children : undefined;
  const mention = text === undefined ? undefined : mentions.get(text);
  if (mention?._tag === "SkillMention") return <SkillChip name={mention.name} />;
  if (mention?._tag === "FileMention") return <FileChip path={mention.path} folder={mention.folder} />;
  const reference = text === undefined ? undefined : pathReference(text);
  if (reference) return <FileChip {...reference} />;
  return (
    <code data-md="inline-code" {...props}>
      {children}
    </code>
  );
}

/** A host as people read it: `docs.github.com`, without `www.`. */
const hostOf = (href: string): string | undefined => {
  try {
    return new URL(href).host.replace(/^www\./, "");
  } catch {
    return undefined;
  }
};

/** Addresses with a scheme (`https:`, `mailto:`); anything else is a path on disk. */
const SCHEME = /^[a-z][a-z\d+.-]*:/i;

/**
 * A link. An `https` one opens in the browser, its whole address under the pointer so the words
 * can't hide where it goes; one to a file on disk is that file's chip; anything else reads as its
 * words, its address in the message menu to copy.
 */
export function Link({ href, children, node }: Part<"a">) {
  const words = textOf(node).trim();
  if (href && !SCHEME.test(href) && !href.startsWith("#")) {
    const reference = pathReference(decodeURI(href));
    if (reference) {
      // Words that are just the file's name (or its path) say nothing the chip doesn't.
      const named = words === "" || reference.path.endsWith(words.replace(/:\d+$/, ""));
      return named ? (
        <FileChip {...reference} />
      ) : (
        <span className="inline-flex flex-wrap items-baseline gap-x-1">
          <span>{children}</span>
          <FileChip {...reference} />
        </span>
      );
    }
  }
  const attributes = href ? { [LINK_ATTRIBUTE]: href } : {};
  if (!href || !isOpenableLink(href)) {
    return (
      <span data-md="link" data-dead="" {...attributes}>
        {children}
      </span>
    );
  }
  const host = hostOf(href);
  return (
    <Tooltip
      side="top"
      delay={350}
      label={
        <span className="flex max-w-80 flex-col gap-0.5">
          <span className="font-medium">{host}</span>
          <span className="truncate text-caption text-fg-tertiary">{href}</span>
        </span>
      }
    >
      <a href={href} target="_blank" rel="noreferrer" data-md="link" {...attributes}>
        <InLink value>{children}</InLink>
      </a>
    </Tooltip>
  );
}

/** Code languages by the name people know them by; any other shows as written. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  javascript: "JavaScript",
  jsx: "JSX",
  mjs: "JavaScript",
  json: "JSON",
  jsonc: "JSON",
  json5: "JSON5",
  sh: "Shell",
  bash: "Shell",
  shell: "Shell",
  shellscript: "Shell",
  zsh: "Shell",
  console: "Shell",
  ps1: "PowerShell",
  powershell: "PowerShell",
  pwsh: "PowerShell",
  cmd: "Command Prompt",
  bat: "Batch",
  py: "Python",
  python: "Python",
  rb: "Ruby",
  ruby: "Ruby",
  rs: "Rust",
  rust: "Rust",
  go: "Go",
  java: "Java",
  kt: "Kotlin",
  kotlin: "Kotlin",
  swift: "Swift",
  c: "C",
  cpp: "C++",
  "c++": "C++",
  cs: "C#",
  csharp: "C#",
  php: "PHP",
  html: "HTML",
  xml: "XML",
  svg: "SVG",
  css: "CSS",
  scss: "SCSS",
  sql: "SQL",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  ini: "INI",
  md: "Markdown",
  markdown: "Markdown",
  mdx: "MDX",
  diff: "Diff",
  patch: "Diff",
  dockerfile: "Dockerfile",
  docker: "Dockerfile",
  graphql: "GraphQL",
  lua: "Lua",
  vue: "Vue",
  svelte: "Svelte",
  text: "Text",
  txt: "Text",
  plaintext: "Text",
};

/** Languages whose files go by another extension, for the file icon a code block wears. */
const LANGUAGE_FILES: Readonly<Record<string, string>> = {
  typescript: "x.ts",
  javascript: "x.js",
  shell: "x.sh",
  shellscript: "x.sh",
  bash: "x.sh",
  zsh: "x.sh",
  console: "x.sh",
  powershell: "x.ps1",
  pwsh: "x.ps1",
  python: "x.py",
  ruby: "x.rb",
  rust: "x.rs",
  markdown: "x.md",
  csharp: "x.cs",
  kotlin: "x.kt",
  dockerfile: "Dockerfile",
  docker: "Dockerfile",
  patch: "x.diff",
};

/** Shell sessions: their copy leaves out the `$ ` prompts, which a terminal would refuse. */
const SHELLS = new Set(["sh", "bash", "shell", "shellscript", "zsh", "console", "ps1", "powershell", "pwsh"]);

/** Lines a code block shows before it folds, and how few hidden lines are worth folding. */
const FOLDED_LINES = 20;
const FOLD_SLACK = 6;

/**
 * A fenced code block: its language and a copy button over the code, highlighted with the file
 * viewer's grammars and colours once the block is whole. A long one folds to its first lines.
 */
export function CodeBlock({ node }: Part<"pre">) {
  const unfinished = useContext(Unfinished);
  const [expanded, setExpanded] = useState(false);
  const code = node?.children?.find((child) => child.tagName === "code");
  const classes = code?.properties?.["className"];
  const language =
    (Array.isArray(classes) ? classes : [])
      .find((name): name is string => typeof name === "string" && name.startsWith("language-"))
      ?.slice("language-".length)
      .toLowerCase() ?? "";
  const text = textOf(code).replace(/\n$/, "");
  const drawn = language === "mermaid" || language === "math";
  const highlighted = useHighlight(
    unfinished || language === "" || drawn ? undefined : text,
    `snippet.${language}`,
  );
  if (language === ARTIFACT_LANGUAGE) return <Artifact code={text} isIncomplete={unfinished} />;
  const lines = text.split("\n");
  const folds = !unfinished && lines.length > FOLDED_LINES + FOLD_SLACK;
  const shown = folds && !expanded ? lines.slice(0, FOLDED_LINES) : lines;
  const diff = language === "diff" || language === "patch";
  const copied = SHELLS.has(language) ? text.replace(/^\$ /gm, "") : text;
  const name = LANGUAGE_NAMES[language] ?? language;
  const view = (note?: string) => (
    <div data-md="code-block" className="group/code relative">
      <div className="flex h-8 items-center gap-1.5 pr-1.5 pl-3">
        {name === "" ? null : (
          <FileIcon path={LANGUAGE_FILES[language] ?? `x.${language}`} className="size-3.5 opacity-90" />
        )}
        <span className="min-w-0 flex-1 truncate text-caption text-fg-tertiary">{name}</span>
        {note === undefined ? null : <span className="shrink-0 text-caption text-fg-tertiary">{note}</span>}
        <CopyButton
          text={copied}
          label="Copy code"
          className={
            name === ""
              ? "opacity-0 group-focus-within/code:opacity-100 group-hover/code:opacity-100 pointer-coarse:opacity-100"
              : ""
          }
        />
      </div>
      <pre
        className={`scroll-thin overflow-x-auto px-3.5 font-mono text-[12.5px] leading-[1.65] text-fg-primary select-text ${
          folds ? "pb-1" : "pb-3"
        } ${folds && !expanded ? "mask-b-from-40%" : ""}`}
      >
        <code className="block w-max min-w-full">
          {shown.map((line, index) => (
            <span key={index} className={`block ${diff ? diffLine(line) : ""}`}>
              <LineText text={line} tokens={diff ? undefined : highlighted?.[index]} />
            </span>
          ))}
        </code>
      </pre>
      {folds ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
          className="flex h-8 w-full items-center px-3.5 text-meta text-fg-tertiary transition-colors hover:text-fg-primary"
        >
          {expanded ? "Show fewer lines" : `Show all ${lines.length} lines`}
        </button>
      ) : null}
    </div>
  );
  if (language === "mermaid") {
    return <Diagram source={text} unfinished={unfinished} fallback={view("Couldn't draw this")} />;
  }
  if (language === "math") {
    return <Formula source={text} display unfinished={unfinished} fallback={view("Couldn't read this")} />;
  }
  return view();
}

/** A diff's line, tinted by what it does. */
const diffLine = (line: string): string =>
  line.startsWith("+") && !line.startsWith("+++")
    ? "-mx-3.5 px-3.5 bg-success/10 text-success-text"
    : line.startsWith("-") && !line.startsWith("---")
      ? "-mx-3.5 px-3.5 bg-error/10 text-error-text"
      : line.startsWith("@@")
        ? "text-fg-tertiary"
        : "";

/** A table's rows as Markdown, which pastes back into a message or a document as the table. */
const tableMarkdown = (table: HtmlNode | undefined): string => {
  const rows: Array<Array<string>> = [];
  const visit = (node: HtmlNode) => {
    if (node.tagName === "tr") {
      rows.push(
        (node.children ?? [])
          .filter((cell) => cell.tagName === "th" || cell.tagName === "td")
          .map((cell) => textOf(cell).trim().replaceAll("|", "\\|")),
      );
      return;
    }
    node.children?.forEach(visit);
  };
  if (table) visit(table);
  const [head, ...body] = rows;
  if (head === undefined) return "";
  const line = (cells: ReadonlyArray<string>) => `| ${cells.join(" | ")} |`;
  return [line(head), line(head.map(() => "---")), ...body.map(line)].join("\n");
};

/** A table that scrolls sideways when it's wider than the column, with a copy button on hover. */
export function Table({ children, node: _node, ...props }: Part<"table">) {
  return (
    <div data-md="table" className="group/table relative">
      <div className="scroll-thin overflow-x-auto">
        <table {...props}>{children}</table>
      </div>
      <CopyButton
        text={tableMarkdown(_node)}
        label="Copy table"
        className="absolute -top-1 right-0 bg-surface-overlay opacity-0 backdrop-blur-xl group-focus-within/table:opacity-100 group-hover/table:opacity-100 pointer-coarse:opacity-100"
      />
    </div>
  );
}

/** A task list's box, ticked or not; it shows the agent's list and can't be ticked here. */
export function TaskCheck({ checked }: Part<"input">) {
  return (
    <span
      data-md="task"
      data-done={checked ? "" : undefined}
      className={`inline-grid size-[1.05em] shrink-0 place-items-center rounded-[0.3em] border ${
        checked ? "border-transparent bg-fg-secondary text-surface-window" : "border-line-strong"
      }`}
    >
      {checked ? <Check size={11} strokeWidth={3} aria-hidden /> : null}
      <span className="sr-only">{checked ? "Done:" : "To do:"}</span>
    </span>
  );
}

const alertLook: Readonly<Record<AlertKind, { readonly icon: LucideIcon; readonly title: string }>> = {
  note: { icon: Info, title: "Note" },
  tip: { icon: Lightbulb, title: "Tip" },
  important: { icon: MessageSquareWarning, title: "Important" },
  warning: { icon: CircleAlert, title: "Warning" },
  caution: { icon: OctagonAlert, title: "Caution" },
};

/** A quote, or one of GitHub's alerts (`> [!NOTE]`) with its icon and title in the alert's hue. */
export function Quote({ children, node }: Part<"blockquote">) {
  const kind = node?.properties?.["dataAlert"] as AlertKind | undefined;
  if (kind === undefined || !(kind in alertLook)) return <blockquote>{children}</blockquote>;
  const { icon: Icon, title } = alertLook[kind];
  return (
    <aside data-md="alert" data-alert={kind}>
      <p data-md="alert-title">
        <Icon size={14} strokeWidth={2} className="shrink-0" />
        {title}
      </p>
      {children}
    </aside>
  );
}

/** An image the agent put in its reply, at its own size up to the column's. */
export function Image({ src, alt, title, node: _node }: Part<"img">) {
  if (typeof src !== "string" || src === "") return alt ? <span>{alt}</span> : null;
  return <img src={src} alt={alt ?? ""} title={title} loading="lazy" draggable={false} data-md="image" />;
}

/** The elements of agent markdown, by tag. */
export const parts = {
  code: InlineCode,
  pre: CodeBlock,
  a: Link,
  table: Table,
  input: TaskCheck,
  blockquote: Quote,
  img: Image,
};

export type MarkdownImageProps = Part<"img">;
export type MarkdownLinkProps = { readonly href?: string | undefined; readonly children?: ReactNode };
