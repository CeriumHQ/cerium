import { describe, expect, it } from "@effect/vitest";

import { compactTokens, plainExcerpt, usd } from "../src/lib/format.ts";

describe("compactTokens", () => {
  it("shortens counts to thousands and millions", () => {
    expect(compactTokens(870)).toBe("870");
    expect(compactTokens(1_234)).toBe("1.2k");
    expect(compactTokens(2_000)).toBe("2k");
    expect(compactTokens(9_960)).toBe("10k");
    expect(compactTokens(157_400)).toBe("157k");
    expect(compactTokens(999_600)).toBe("1M");
    expect(compactTokens(1_136_000)).toBe("1.1M");
    expect(compactTokens(24_500_000)).toBe("25M");
  });
});

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
