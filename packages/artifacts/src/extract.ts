// Finding artifacts in agents' markdown, for the gallery that lists them apart from the conversation.

import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

/** The code fence language that marks an artifact in agent markdown. */
export const ARTIFACT_LANGUAGE = "artifact";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

/**
 * The artifacts in a message's markdown, in order: the body of each closed ` ```artifact ` fence,
 * as the transcript renders it. A fence still open (a message being written) holds none yet.
 */
export const artifactBlocks = (markdown: string): ReadonlyArray<string> => {
  const found: Array<string> = [];
  const visit = (
    node: ReturnType<typeof parser.parse> | ReturnType<typeof parser.parse>["children"][number],
  ): void => {
    if (node.type === "code" && node.lang?.toLowerCase() === ARTIFACT_LANGUAGE && node.value.trim() !== "") {
      const position = node.position;
      const start = position?.start.offset;
      const end = position?.end.offset;
      if (start !== undefined && end !== undefined && position !== undefined) {
        const opening = /^(`{3,}|~{3,})/.exec(markdown.slice(start))?.[1];
        const lastLine = markdown.slice(markdown.lastIndexOf("\n", end - 1) + 1, end);
        const closing = /(`+|~+)[ \t]*$/.exec(lastLine)?.[1];
        // A closed fence has an extra source line beyond its opening and normalized body.
        // Checking this too rejects marker-shaped body lines indented too far to close it.
        const bodyLines = node.value.split("\n").length;
        if (
          opening &&
          closing &&
          opening[0] === closing[0] &&
          closing.length >= opening.length &&
          position.end.line - position.start.line === bodyLines + 1
        )
          found.push(node.value);
      }
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(parser.parse(markdown));
  return found;
};

/**
 * A short, stable name for an artifact's code, the same wherever it is found: the gallery finds the
 * artifact in the conversation by it.
 */
export const artifactId = (code: string): string => {
  let hash = 0x811c9dc5;
  const text = code.trim();
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `a${(hash >>> 0).toString(36)}${text.length.toString(36)}`;
};

/**
 * The artifacts in messages given newest first, newest first and one copy of each page (its latest),
 * at most `limit`: what the artifacts panel lists.
 */
export const newestArtifacts = <M extends { readonly text: string }>(
  messages: Iterable<M>,
  limit: number,
): Array<{ readonly message: M; readonly code: string; readonly id: string }> => {
  const listed: Array<{ readonly message: M; readonly code: string; readonly id: string }> = [];
  const seen = new Set<string>();
  for (const message of messages) {
    for (const code of artifactBlocks(message.text).toReversed()) {
      const id = artifactId(code);
      if (seen.has(id)) continue;
      seen.add(id);
      listed.push({ message, code, id });
      if (listed.length >= limit) return listed;
    }
  }
  return listed;
};

/** The artifact's `<title>`, which agents are asked to give it, or else its first heading. */
export const artifactTitle = (code: string): string | undefined => {
  const markup = code.replace(/<(script|style)\b[\s\S]*?(<\/\1\s*>|$)/gi, "");
  const found =
    /<title[^>]*>([^<]*)<\/title>/i.exec(markup)?.[1] ??
    /<(h[1-4])\b[^>]*>([\s\S]*?)<\/\1>/i.exec(markup)?.[2];
  const title = found
    ?.replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    // Last, so "&amp;lt;" stays "&lt;".
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return title ? title.slice(0, 80) : undefined;
};
