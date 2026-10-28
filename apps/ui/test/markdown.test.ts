import { describe, expect, it } from "@effect/vitest";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import { closeOpenSyntax, openFence, splitBlocks } from "../src/features/transcript/markdownBlocks.ts";
import { rehypeAlerts, rehypeInk } from "../src/features/transcript/markdownPlugins.ts";

const html = (markdown: string, ...plugins: Array<() => (tree: never) => void>) =>
  String(
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype)
      .use(plugins as never)
      .use(rehypeStringify)
      .processSync(markdown),
  );

describe("splitBlocks", () => {
  it("cuts text into its top-level blocks, each with the blank lines after it", () => {
    expect(splitBlocks("# Title\n\nSome text.\n\n- a\n- b\n")).toEqual([
      "# Title\n\n",
      "Some text.\n\n",
      "- a\n- b\n",
    ]);
  });

  it("keeps a list whose items are apart, and a fence with blank lines, whole", () => {
    expect(splitBlocks("- a\n\n- b\n\n```ts\nx\n\ny\n```\n")).toEqual([
      "- a\n\n- b\n\n",
      "```ts\nx\n\ny\n```\n",
    ]);
  });

  it("splits a growing text as it would split the whole of it", () => {
    const text = "Intro.\n\n1. one\n2. two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nDone.";
    for (let end = 1; end <= text.length; end++) {
      const grown = splitBlocks(text.slice(0, end));
      expect(grown.join("")).toBe(text.slice(0, end));
    }
    expect(splitBlocks(text)).toEqual([
      "Intro.\n\n",
      "1. one\n2. two\n\n",
      "| a | b |\n| - | - |\n| 1 | 2 |\n\n",
      "Done.",
    ]);
  });

  it("gives empty text one empty block", () => {
    expect(splitBlocks("")).toEqual([""]);
  });
});

describe("openFence", () => {
  it("tells a code fence still being written from a closed one", () => {
    expect(openFence("```ts\nconst a = 1;")).toBe(true);
    expect(openFence("```ts\nconst a = 1;\n```")).toBe(false);
    expect(openFence("````md\n```\ninner\n```\n")).toBe(true);
    expect(openFence("~~~\nx\n~~~")).toBe(false);
    expect(openFence("Just text with ``` in it")).toBe(false);
  });
});

describe("closeOpenSyntax", () => {
  it("closes the inline marks the last line opened", () => {
    expect(closeOpenSyntax("This is **bold")).toBe("This is **bold**");
    expect(closeOpenSyntax("Some *italic and **both")).toBe("Some *italic and **both***");
    expect(closeOpenSyntax("Run `bun test")).toBe("Run `bun test`");
    expect(closeOpenSyntax("~~gone")).toBe("~~gone~~");
  });

  it("leaves closed marks, snake_case and list markers alone", () => {
    expect(closeOpenSyntax("Already **done** here")).toBe("Already **done** here");
    expect(closeOpenSyntax("call refresh_session_now")).toBe("call refresh_session_now");
    expect(closeOpenSyntax("* a list item")).toBe("* a list item");
    expect(closeOpenSyntax("Use `a*b` here")).toBe("Use `a*b` here");
  });

  it("shows a link still being written as its words", () => {
    expect(closeOpenSyntax("See [the docs](https://bun.sh/do")).toBe("See the docs");
    expect(closeOpenSyntax("See [the do")).toBe("See the do");
    expect(closeOpenSyntax("See [done](https://a.b) and [next")).toBe("See [done](https://a.b) and next");
  });

  it("drops a heading or underline with nothing to it yet", () => {
    expect(closeOpenSyntax("Text\n\n##")).toBe("Text\n");
    expect(closeOpenSyntax("A paragraph\n-")).toBe("A paragraph");
  });

  it("leaves an open code fence to render to the end", () => {
    expect(closeOpenSyntax("```ts\nconst a = **b")).toBe("```ts\nconst a = **b");
  });
});

describe("rehypeAlerts", () => {
  it("marks a GitHub alert and takes its mark off the text", () => {
    expect(html("> [!WARNING]\n> Back up first.", rehypeAlerts)).toBe(
      '<blockquote data-alert="warning">\n<p>Back up first.</p>\n</blockquote>',
    );
  });

  it("leaves a plain quote as it is", () => {
    expect(html("> Just a quote.", rehypeAlerts)).toBe("<blockquote>\n<p>Just a quote.</p>\n</blockquote>");
  });
});

describe("rehypeInk", () => {
  it("staggers the words written since `from` and leaves the earlier ones settled", () => {
    const out = html("One two three", rehypeInk(4));
    expect(out).toBe(
      '<p><span class="ink" style="animation-delay:0ms">One</span> <span class="ink" style="animation-delay:0ms">two</span> <span class="ink" style="animation-delay:22ms">three</span></p>',
    );
  });

  it("leaves code alone", () => {
    expect(html("Use `a b`", rehypeInk(0))).toBe(
      '<p><span class="ink" style="animation-delay:0ms">Use</span> <code>a b</code></p>',
    );
  });
});
