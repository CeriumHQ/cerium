import { describe, expect, it } from "@effect/vitest";
import { parseCheckouts, sameCheckout, insideCheckout } from "../src/checkouts.ts";

describe("checkout discovery", () => {
  it("keeps paths literal, preserves detached checkouts and does not turn trailing fields into rows", () => {
    const output =
      "worktree /code/has a\nnewline\0HEAD abc\0branch refs/heads/feature/a\0\0worktree /code/review\0HEAD def\0detached\0\0";
    const rows = parseCheckouts(output, []);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      path: "/code/has a\nnewline",
      branch: "feature/a",
      head: "abc",
      detached: false,
    });
    expect(rows[1]).toMatchObject({ path: "/code/review", detached: true });
    expect(parseCheckouts(output, [])[0]?.id).toBe(rows[0]?.id);
  });
  it("does not treat a sibling folder as the same checkout", () => {
    expect(sameCheckout("/code/a", "/code/ab")).toBe(false);
    expect(insideCheckout("/code/a", "/code/a/app")).toBe(true);
    expect(insideCheckout("/code/a", "/code/ab/app")).toBe(false);
    expect(sameCheckout("/code/a/", "/code/a")).toBe(true);
    expect(parseCheckouts("", [])).toEqual([]);
  });
});
