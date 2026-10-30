import type { AgentEvent, HistoryCursor } from "@cerium/protocol";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { buildTranscript, type TranscriptBlock } from "./model.ts";

export interface SearchMessage {
  readonly id: string;
  readonly text: string;
  readonly cursor?: HistoryCursor;
}
export interface ModelMatch {
  readonly message: SearchMessage;
  readonly ordinal: number;
}

/** Search rendered words, including phrases across inline formatting, without rendering Markdown. */
const parser = unified().use(remarkParse);
interface TextNode {
  readonly type: string;
  readonly value?: string | undefined;
  readonly lang?: string | null | undefined;
  readonly children?: ReadonlyArray<TextNode>;
}
const words = (node: TextNode): string => {
  if (node.type === "definition" || node.type === "image" || node.type === "imageReference") return "";
  if (node.type === "code" && node.lang === "artifact") return "";
  if (node.type === "html") return (node.value ?? "").replace(/<[^>]*>/gu, "");
  if (node.value !== undefined) return node.value;
  return node.children?.map(words).join(node.type === "root" ? "\n" : "") ?? "";
};
export const searchableText = (markdown: string): string => words(parser.parse(markdown));

export const searchMessages = (blocks: ReadonlyArray<TranscriptBlock>): ReadonlyArray<SearchMessage> =>
  blocks.flatMap((block) => {
    if (block.kind === "replaced") return searchMessages(block.blocks);
    return block.kind === "user" || block.kind === "message" ? [{ id: block.id, text: block.text }] : [];
  });

export const messagesFromHistory = (events: ReadonlyArray<AgentEvent>): ReadonlyArray<SearchMessage> => {
  const cursors = new Map<string, HistoryCursor>();
  for (const event of events) {
    const cursor = { at: event.at, sequence: event.sequence, id: event.id };
    if (event.payload._tag === "MessageCompleted") cursors.set(`message:${event.payload.messageId}`, cursor);
    if (event.payload._tag === "TurnInput")
      for (const [n, item] of event.payload.items.entries()) {
        if (item._tag === "FromUser") cursors.set(item.id ?? `${event.id}:${n}`, cursor);
      }
  }
  return searchMessages(buildTranscript(events)).map((message) => {
    const cursor = cursors.get(message.id);
    return cursor === undefined ? message : { ...message, cursor };
  });
};

export const modelMatches = (
  messages: ReadonlyArray<SearchMessage>,
  query: string,
): ReadonlyArray<ModelMatch> => {
  if (query === "") return [];
  const needle = query.toLocaleLowerCase();
  return messages.flatMap((message) => {
    const text = searchableText(message.text).toLocaleLowerCase();
    const found: Array<ModelMatch> = [];
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length))
      found.push({ message, ordinal: found.length });
    return found;
  });
};
