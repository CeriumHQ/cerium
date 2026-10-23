import { describe, expect, it } from "@effect/vitest";

import { toggleFavorite } from "../src/features/composer/favorites.ts";

describe("toggleFavorite", () => {
  it("stars a model after the ones already starred", () => {
    expect(toggleFavorite(["claude/opus"], "codex/gpt")).toEqual(["claude/opus", "codex/gpt"]);
  });

  it("unstars a starred model and keeps the others' order", () => {
    expect(toggleFavorite(["a/1", "b/2", "c/3"], "b/2")).toEqual(["a/1", "c/3"]);
  });
});
