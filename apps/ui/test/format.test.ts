import { describe, expect, it } from "@effect/vitest";

import { plainExcerpt, usd } from "../src/lib/format.ts";

describe("usd", () => {
  it("never shows a turn that cost something as free", () => {
    expect(usd(0.004)).toBe("<$0.01");
    expect(usd(0)).toBe("$0.00");
    expect(usd(1.237)).toBe("$1.24");
  });
});

describe("plainExcerpt", () => {
  it("flattens markdown into one line of text", () => {
    const markdown = [
      "## Done",
      "",
      "- `add(a, b)`: returns **5**",
      "- see [the docs](https://example.com) for *more*",
      "",
      "```ts",
      "const snake_case = 1;",
      "```",
    ].join("\n");
    expect(plainExcerpt(markdown)).toBe(
      "Done add(a, b): returns 5 see the docs for more const snake_case = 1;",
    );
  });
});
