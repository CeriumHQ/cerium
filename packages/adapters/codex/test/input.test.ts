import { describe, expect, it } from "@effect/vitest";

import { toUserInput } from "../src/session.ts";

describe("toUserInput", () => {
  it("adds images by path and the skills Codex reported a file for", () => {
    expect(
      toUserInput("Use $review on this", {
        images: [{ path: "C:/shots/a.png", mediaType: "image/png", data: "iVBOR" }],
        skills: [{ name: "review", path: "C:/skills/review/SKILL.md" }, { name: "unknown" }],
      }),
    ).toEqual([
      { type: "text", text: "Use $review on this", text_elements: [] },
      { type: "localImage", path: "C:/shots/a.png" },
      { type: "skill", name: "review", path: "C:/skills/review/SKILL.md" },
    ]);
  });
});
