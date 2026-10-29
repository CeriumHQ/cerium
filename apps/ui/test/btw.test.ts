import { describe, expect, it } from "@effect/vitest";

import { sideQuestionOf } from "../src/features/composer/btw.ts";

describe("sideQuestionOf", () => {
  it("reads what follows /btw as the question", () => {
    expect(sideQuestionOf("/btw why is the build red?")).toBe("why is the build red?");
    expect(sideQuestionOf("  /BTW   two\nlines ")).toBe("two\nlines");
  });

  it("opens an empty pop-over for a bare /btw", () => {
    expect(sideQuestionOf("/btw")).toBe("");
    expect(sideQuestionOf("/btw  ")).toBe("");
  });

  it("leaves other messages alone", () => {
    expect(sideQuestionOf("/btwfoo")).toBeUndefined();
    expect(sideQuestionOf("use /btw to ask")).toBeUndefined();
    expect(sideQuestionOf("hello")).toBeUndefined();
  });
});
