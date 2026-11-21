import { describe, expect, it } from "@effect/vitest";

import { toTurnInput } from "../src/session.ts";

describe("toTurnInput", () => {
  it("sends the text, then each image as base64; unrecognized skills stay in the text", () => {
    expect(
      toTurnInput("Use $review on this", {
        images: [{ path: "/shots/a.png", mediaType: "image/png", data: "iVBOR" }],
        skills: [{ name: "review" }],
      }),
    ).toEqual([
      { type: "text", text: "Use $review on this" },
      { type: "image", base64Data: "iVBOR", mediaType: "image/png" },
    ]);
  });
  it("uses a native input part once for each discovered skill", () => {
    expect(
      toTurnInput(
        "Use $review and $missing",
        { skills: [{ name: "review" }, { name: "missing" }, { name: "review" }] },
        new Set(["review"]),
      ),
    ).toEqual([
      { type: "text", text: "Use $review and $missing" },
      { type: "skill", selector: "review" },
    ]);
  });
});
