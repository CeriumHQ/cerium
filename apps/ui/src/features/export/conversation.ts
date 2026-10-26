import type { ProviderId } from "@cerium/protocol";

import type { TranscriptBlock } from "../transcript/model.ts";
import { exportedToolLine, toolImages, type ToolBlock } from "../transcript/tools.ts";

// Writing a thread out as a document: the conversation as the transcript folds it, without the tools'
// inputs and outputs, reasoning or the rest of what the window shows around it.

export type ExportFormat = "markdown" | "text";

/** The fence an artifact opens with, rewritten as the HTML it holds; the closing fence stays as written. */
const artifactsAsHtml = (text: string): string =>
  text.replace(/^(\s*)(`{3,}|~{3,})artifact[ \t]*$/gm, "$1$2html");

export interface ConversationSource {
  readonly title: string;
  /** The thread's folder, which tool paths are written relative to; absent for a chat. */
  readonly folder?: string | undefined;
  /** The lead's transcript, folded by `buildTranscript`. */
  readonly blocks: ReadonlyArray<TranscriptBlock>;
  /** A model's name as people know it, for the responses it wrote. */
  readonly modelName: (model: string, provider: ProviderId | undefined) => string;
  /** The name of the model the lead starts on, for a response before any model is recorded. */
  readonly initialModel: string;
}

/**
 * The thread as a document: each of the user's messages under "You", each response under the name of
 * the model that wrote it, with its tool calls as one line apiece and its images by file path.
 * Artifacts come out as their HTML. Blocks a rewind replaced are left out, as the conversation now
 * reads without them.
 */
export const conversationDocument = (source: ConversationSource, format: ExportFormat): string => {
  const markdown = format === "markdown";
  const heading = (level: number, text: string) => (markdown ? `${"#".repeat(level)} ${text}` : `${text}:`);
  const parts: Array<string> = [markdown ? `# ${source.title}` : source.title];
  let bullets: Array<string> = [];
  /** The model the response being written is labelled with, once its header is out. */
  let open: string | undefined;
  let model = source.initialModel;

  const flush = () => {
    if (bullets.length > 0) parts.push(bullets.join("\n"));
    bullets = [];
  };
  /** Starts a response's section when the model changes or a user's message came between. */
  const respond = () => {
    if (open === model) return;
    flush();
    parts.push(heading(2, model));
    open = model;
  };
  const image = (name: string, path: string) => (markdown ? `![${name}](<${path}>)` : `Image: ${path}`);
  const file = (name: string, path: string) => (markdown ? `[${name}](<${path}>)` : `File: ${path}`);
  const toolFiles = (tool: ToolBlock) =>
    toolImages(tool).flatMap((shown) => (shown.path === undefined ? [] : [image(shown.name, shown.path)]));

  for (const block of source.blocks) {
    switch (block.kind) {
      case "user": {
        flush();
        open = undefined;
        parts.push(heading(2, "You"));
        if (block.text.trim() !== "") parts.push(artifactsAsHtml(block.text.trim()));
        const attached = block.attachments.map((attachment) =>
          attachment.mediaType.startsWith("image/")
            ? image(attachment.name, attachment.path)
            : file(attachment.name, attachment.path),
        );
        if (attached.length > 0) parts.push(attached.join("\n"));
        break;
      }
      case "model":
        model = source.modelName(block.model, block.provider);
        break;
      case "message":
        if (block.text.trim() === "") break;
        respond();
        flush();
        parts.push(artifactsAsHtml(block.text.trim()));
        break;
      case "tool":
        respond();
        bullets.push(`- ${exportedToolLine(block, source.folder)}`);
        // Consecutive tool calls form one list; an image they showed follows it.
        if (toolFiles(block).length > 0) {
          flush();
          parts.push(toolFiles(block).join("\n"));
        }
        break;
      case "error":
        respond();
        flush();
        parts.push(`Error: ${block.message}`);
        break;
      default:
        break;
    }
  }
  flush();
  return `${parts.join("\n\n")}\n`;
};
