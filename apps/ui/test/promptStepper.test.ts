import { describe, expect, it } from "@effect/vitest";

import { layout } from "../src/features/transcript/layout.ts";
import type { TranscriptBlock } from "../src/features/transcript/model.ts";
import { promptsOf } from "../src/features/transcript/PromptStepper.tsx";

const user = (id: string, text: string, files: ReadonlyArray<string> = []): TranscriptBlock => ({
  kind: "user",
  id,
  text,
  attachments: files.map((name) => ({ path: `C:/files/${name}`, name, mediaType: "image/png" })),
  mentions: [],
});
const message = (id: string, text: string): TranscriptBlock => ({
  kind: "message",
  id,
  text,
  streaming: false,
});

describe("promptsOf", () => {
  it("marks each message the user sent, on one line", () => {
    const items = layout([user("u1", "Fix the\n  build"), message("m1", "Done."), user("u2", "Thanks")]);
    expect(promptsOf(items)).toEqual([
      { id: "u1", label: "Fix the build" },
      { id: "u2", label: "Thanks" },
    ]);
  });

  it("names the files a prompt sent when it said nothing", () => {
    expect(promptsOf(layout([user("u1", "  ", ["image.png"])]))).toEqual([{ id: "u1", label: "image.png" }]);
  });

  it("joins messages sent back to back into one prompt", () => {
    expect(promptsOf(layout([user("u1", "One"), user("u2", "two")]))).toEqual([
      { id: "u1", label: "One two" },
    ]);
  });
});
