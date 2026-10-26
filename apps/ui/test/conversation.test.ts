import { describe, expect, it } from "@effect/vitest";

import { conversationDocument, type ConversationSource } from "../src/features/export/conversation.ts";
import type { TranscriptBlock } from "../src/features/transcript/model.ts";

const source = (blocks: ReadonlyArray<TranscriptBlock>): ConversationSource => ({
  title: "Fix the sidebar",
  folder: "C:\\proj",
  blocks,
  modelName: (model) => (model === "opus" ? "Opus 5.5" : model),
  initialModel: "Opus 5.5",
});

const user = (id: string, text: string): TranscriptBlock => ({
  kind: "user",
  id,
  text,
  attachments: [],
  mentions: [],
});

const message = (id: string, text: string): TranscriptBlock => ({
  kind: "message",
  id,
  text,
  streaming: false,
});

const edit: TranscriptBlock = {
  kind: "tool",
  id: "tool:1",
  toolName: "Edit",
  input: { file_path: "C:\\proj\\apps\\ui\\src\\App.tsx" },
  status: "done",
  changedFiles: [],
};

describe("conversationDocument", () => {
  it("writes the title, each message under its heading and each response under its model", () => {
    const text = conversationDocument(
      source([
        user("u1", "Why is the sidebar slow?"),
        { kind: "model", id: "m0", model: "opus", change: "start" },
        message("a1", "It re-renders every card."),
        edit,
        {
          kind: "tool",
          id: "tool:2",
          toolName: "Bash",
          input: { command: "bun test" },
          status: "done",
          changedFiles: [],
        },
        user("u2", "Thanks"),
        message("a2", "You're welcome."),
      ]),
      "markdown",
    );
    expect(text).toBe(
      [
        "# Fix the sidebar",
        "## You\n\nWhy is the sidebar slow?",
        "## Opus 5.5\n\nIt re-renders every card.",
        "- Edited apps/ui/src/App.tsx\n- Ran bun test",
        "## You\n\nThanks",
        "## Opus 5.5\n\nYou're welcome.",
      ].join("\n\n") + "\n",
    );
  });

  it("writes plain headings and no Markdown marks in text", () => {
    const text = conversationDocument(
      source([
        user("u1", "Hi"),
        { kind: "model", id: "m0", model: "opus", change: "start" },
        message("a1", "Hello"),
      ]),
      "text",
    );
    expect(text).toBe("Fix the sidebar\n\nYou:\n\nHi\n\nOpus 5.5:\n\nHello\n");
  });

  it("labels a response again after the model switches within it", () => {
    const text = conversationDocument(
      source([
        user("u1", "Go"),
        message("a1", "First."),
        { kind: "model", id: "m1", model: "sonnet", change: "model" },
        message("a2", "Second."),
      ]),
      "markdown",
    );
    expect(text).toContain("## Opus 5.5\n\nFirst.");
    expect(text).toContain("## sonnet\n\nSecond.");
  });

  it("references images by their file path and rewrites artifacts as HTML", () => {
    const text = conversationDocument(
      source([
        {
          kind: "user",
          id: "u1",
          text: "See this",
          attachments: [{ path: "C:\\shots\\a b.png", name: "a b.png", mediaType: "image/png" }],
          mentions: [],
        },
        message("a1", "```artifact\n<div>hi</div>\n```"),
      ]),
      "markdown",
    );
    expect(text).toContain("![a b.png](<C:\\shots\\a b.png>)");
    expect(text).toContain("```html\n<div>hi</div>\n```");
  });

  it("leaves out what a rewind replaced, reasoning and the turn's footer", () => {
    const text = conversationDocument(
      source([
        user("u0", "Old"),
        { kind: "replaced", id: "r", blocks: [message("x", "Gone")] },
        { kind: "reasoning", id: "rs", text: "thinking", streaming: false },
        user("u1", "New"),
        message("a1", "Kept"),
        { kind: "turnEnd", id: "t", stopReason: "completed" },
      ]),
      "markdown",
    );
    expect(text).not.toContain("Gone");
    expect(text).not.toContain("thinking");
    expect(text).toContain("## You\n\nNew");
  });
});
