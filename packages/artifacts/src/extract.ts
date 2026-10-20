// Finding artifacts in agents' markdown, for the gallery that lists them apart from the conversation.

/** The code fence language that marks an artifact in agent markdown. */
export const ARTIFACT_LANGUAGE = "artifact";

const OPENING = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/;
const CLOSING = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * The artifacts in a message's markdown, in order: the body of each closed ` ```artifact ` fence,
 * as the transcript renders it. A fence still open (a message being written) holds none yet.
 */
export const artifactBlocks = (markdown: string): ReadonlyArray<string> => {
  const found: Array<string> = [];
  let open: { readonly fence: string; readonly artifact: boolean; readonly body: Array<string> } | undefined;
  for (const raw of markdown.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (open === undefined) {
      const start = OPENING.exec(line);
      // A backtick fence's info string can't hold a backtick, so "```artifact```" isn't one.
      if (start && !(start[1]!.startsWith("`") && line.slice(start[0].length).includes("`"))) {
        open = { fence: start[1]!, artifact: start[2]!.toLowerCase() === ARTIFACT_LANGUAGE, body: [] };
      }
      continue;
    }
    const end = CLOSING.exec(line);
    if (end && end[1]![0] === open.fence[0] && end[1]!.length >= open.fence.length) {
      if (open.artifact && open.body.join("").trim() !== "") found.push(open.body.join("\n"));
      open = undefined;
    } else {
      open.body.push(line);
    }
  }
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
