import { assert, describe, it } from "@effect/vitest";
import { Script } from "node:vm";

import {
  artifactBlocks,
  artifactId,
  artifactTitle,
  newestArtifacts,
  artifactDocument,
  artifactHostPage,
  dataFileUrl,
  DEFAULT_THEMES,
  isLegacyArtifact,
  localFiles,
  readFrameMessage,
  themeUpdate,
  withLocalFiles,
} from "../src/index.ts";

const theme = DEFAULT_THEMES.dark;

describe("themes", () => {
  it("keep values from closing the stylesheet", () => {
    const hostile = {
      mode: "dark" as const,
      variables: { "--foreground": "red;}</style><script>x()</script>", "bad name": "1" },
    };
    const { css } = themeUpdate(hostile, false);
    assert.notInclude(css, "</style>");
    assert.notInclude(css, "bad name");
    assert.include(css, "color-scheme: dark");
  });

  it("alias Cerium's token names for legacy pages only", () => {
    assert.include(themeUpdate(theme, true).css, "--fg-primary:");
    assert.notInclude(themeUpdate(theme, false).css, "--fg-primary:");
  });
});

describe("artifactDocument", () => {
  it("wraps a fragment in a standards-mode document with Cerium's head first", () => {
    const html = artifactDocument("<style>p{color:red}</style><p>hi</p>", { theme });
    assert.match(html, /^<!doctype html>/);
    assert.isBelow(html.indexOf('<style id="cerium-theme">'), html.indexOf("p{color:red}"));
    assert.include(html, "Content-Security-Policy");
    assert.include(html, "<p>hi</p>");
  });

  it("puts the head inside a document's own, ahead of its styles", () => {
    const page =
      '<!DOCTYPE html><html lang="en"><head><style>:root{--foreground:red}</style></head><body>x</body></html>';
    const html = artifactDocument(page, { theme });
    assert.match(html, /^<!DOCTYPE html>/);
    const ours = html.indexOf('<style id="cerium-theme">');
    assert.isAbove(ours, html.indexOf("<head>"));
    assert.isBelow(ours, html.indexOf(":root{--foreground:red}"));
  });

  it("inserts after the entire head tag, even with a quoted greater-than sign", () => {
    const page = '<!doctype html><html><head data-example="a > b"><script>first()</script></head></html>';
    const html = artifactDocument(page, { theme });
    assert.include(html, '<head data-example="a > b">\n<meta charset="utf-8">');
    assert.isBelow(html.indexOf("Content-Security-Policy"), html.indexOf("first()"));
  });

  it("puts policy before an implicit head's content and ignores fake heads and titles", () => {
    const page = '<!doctype html><html lang="en"><title>Own</title><script>first()</script><body>x</body>';
    const html = artifactDocument(page, { theme, title: "Other" });
    assert.include(html, '<html lang="en"><head>');
    assert.isBelow(html.indexOf("Content-Security-Policy"), html.indexOf("first()"));
    assert.notInclude(html, "<title>Other</title>");
    const fragment = artifactDocument("<!-- <head><title>fake</title> --><p>x</p>", { theme, title: "Real" });
    assert.include(fragment, "<title>Real</title>");
  });

  it("adds a doctype to a document without one", () => {
    assert.match(artifactDocument("<html><body>x</body></html>", { theme }), /^<!doctype html><html><head>/);
  });

  it("ignores a head written inside a script or a comment", () => {
    const page = "<!-- <head> --><p>x</p><script>const tag = '<head>';</script>";
    const html = artifactDocument(page, { theme });
    assert.match(html, /^<!doctype html>\n<html><head>/);
    assert.include(html, "const tag = '<head>';");
  });

  it("makes a page of its own, titled, to save or open", () => {
    const html = artifactDocument("<p>x</p>", { theme, standalone: true, title: 'Q3 <"plan">' });
    assert.include(html, "background: var(--background)");
    assert.include(html, "<title>Q3 &lt;&quot;plan&quot;&gt;</title>");
    const titled = artifactDocument("<title>Own</title><p>x</p>", {
      theme,
      standalone: true,
      title: "Other",
    });
    assert.notInclude(titled, "<title>Other</title>");
    assert.notInclude(artifactDocument("<p>x</p>", { theme }), "background: var(--background)");
  });

  it("brings the frozen stylesheet to legacy pages only", () => {
    const legacyCss = ".card{border:1px solid}";
    assert.include(artifactDocument('<div class="card">x</div>', { theme, legacyCss }), legacyCss);
    assert.notInclude(
      artifactDocument('<style>.card{}</style><div class="card">x</div>', { theme, legacyCss }),
      legacyCss,
    );
  });
});

describe("isLegacyArtifact", () => {
  it("tells building-block fragments from pages that style themselves", () => {
    assert.isTrue(isLegacyArtifact('<div class="grid"><div class="card good">x</div></div>'));
    assert.isFalse(isLegacyArtifact('<style>.x{}</style><div class="x">x</div>'));
    assert.isFalse(isLegacyArtifact('<div class="x"></div><script src="https://x"></script>'));
    assert.isFalse(isLegacyArtifact('<!doctype html><div class="card"></div>'));
    assert.isFalse(isLegacyArtifact("<p>plain</p>"));
  });
});

describe("local files", () => {
  const page = [
    '<img src="C:\\shots\\after.png" alt="">',
    "<img src='/home/me/plot.SVG'>",
    '<div style="background: url(D:/art/bg.webp)"></div>',
    '<style>.hero { background: url("file:///C:/My%20Pictures/hero.jpg"); }</style>',
    '<script>const shot = "C:\\\\shots\\\\after.png"; const remote = "https://example.com/a.png";</script>',
    '<a href="//cdn.example.com/x.png">x</a><p>/not/quoted.png</p><img src="relative/a.png">',
    '<script>fetch("C:/work/app/data/sales.csv"); d3.json(`/srv/app/stats.json`); const label = "package.json";</script>',
  ].join("\n");

  it("finds the files a page names by absolute path, each once", () => {
    assert.deepStrictEqual(localFiles(page), [
      "C:\\shots\\after.png",
      "/home/me/plot.SVG",
      "C:/My Pictures/hero.jpg",
      "C:/work/app/data/sales.csv",
      "/srv/app/stats.json",
      "D:/art/bg.webp",
    ]);
    assert.deepStrictEqual(localFiles("<p>No files</p>"), []);
  });

  it("embeds a data file's text so fetch reads it back", async () => {
    const url = dataFileUrl("text/csv", "region,total\nNord,1 204 €\n");
    assert.match(url, /^data:text\/csv;charset=utf-8;base64,/);
    assert.strictEqual(await (await fetch(url)).text(), "region,total\nNord,1 204 €\n");
    const html = withLocalFiles(page, new Map([["C:/work/app/data/sales.csv", url]]));
    assert.include(html, `fetch("${url}")`);
    assert.include(html, 'const label = "package.json"');
  });

  it("puts each file's data URL in place of every way the page wrote it", () => {
    const images = new Map([
      ["C:\\shots\\after.png", "data:image/png;base64,AAA"],
      ["D:/art/bg.webp", "data:image/webp;base64,BBB"],
      ["C:/My Pictures/hero.jpg", "data:image/jpeg;base64,CCC"],
    ]);
    const html = withLocalFiles(page, images);
    assert.include(html, '<img src="data:image/png;base64,AAA" alt="">');
    assert.include(html, 'const shot = "data:image/png;base64,AAA"');
    assert.include(html, "url(data:image/webp;base64,BBB)");
    assert.include(html, 'url("data:image/jpeg;base64,CCC")');
    // Unread files keep the path they were written with.
    assert.include(html, "<img src='/home/me/plot.SVG'>");
    assert.include(html, "https://example.com/a.png");
    assert.strictEqual(withLocalFiles(page, new Map()), page);
  });
});

describe("readFrameMessage", () => {
  it("reads only well-formed messages", () => {
    assert.deepStrictEqual(readFrameMessage({ type: "cerium-artifact:height", height: 412 }), {
      kind: "height",
      height: 412,
    });
    assert.isUndefined(readFrameMessage({ type: "cerium-artifact:height", height: "412" }));
    assert.deepStrictEqual(readFrameMessage({ type: "cerium-artifact:link", url: "https://example.com" }), {
      kind: "link",
      url: "https://example.com",
    });
    assert.isUndefined(readFrameMessage({ type: "cerium-artifact:link", url: "javascript:alert(1)" }));
    assert.isUndefined(readFrameMessage({ type: "cerium-artifact:link", url: "file:///etc/passwd" }));
    assert.deepStrictEqual(
      readFrameMessage({ type: "cerium-artifact:key", key: "k", code: "KeyK", ctrlKey: true }),
      {
        kind: "key",
        key: "k",
        code: "KeyK",
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      },
    );
    assert.deepStrictEqual(readFrameMessage({ type: "cerium-artifact:reply", text: "  Go with B " }), {
      kind: "reply",
      text: "Go with B",
    });
    assert.isUndefined(readFrameMessage({ type: "cerium-artifact:reply", text: "   " }));
    assert.strictEqual(
      (readFrameMessage({ type: "cerium-artifact:reply", text: "x".repeat(9000) }) as { text: string }).text
        .length,
      4000,
    );
    assert.isUndefined(readFrameMessage({ type: "other:height", height: 1 }));
    assert.isUndefined(readFrameMessage("cerium-artifact:ready"));
  });
});

describe("artifactHostPage", () => {
  it("renders only when sandboxed and carries the page policy", () => {
    const page = artifactHostPage();
    assert.include(page, 'self.origin === "null"');
    assert.include(page, "default-src 'none'");
    assert.include(page, "cerium-artifact:render");
    // A tab the app opens for an artifact is driven by the app, its opener.
    assert.include(page, "window.parent.opener");
    assert.doesNotThrow(() => new Script(/<script>([\s\S]*?)<\/script>/.exec(page)![1]!));
  });
});

describe("finding artifacts", () => {
  it("takes each closed artifact fence's body, in order", () => {
    const text = [
      "Here are two.",
      "```artifact",
      "<p>one</p>",
      "```",
      "```ts",
      "const x = 1;",
      "```",
      "````artifact",
      "<pre>```</pre>",
      "````",
      "~~~ARTIFACT",
      "<p>three</p>",
      "~~~",
    ].join("\r\n");
    assert.deepStrictEqual(artifactBlocks(text), ["<p>one</p>", "<pre>```</pre>", "<p>three</p>"]);
  });

  it("skips fences still open, empty ones and inline code", () => {
    assert.deepStrictEqual(artifactBlocks("```artifact\n<p>half"), []);
    assert.deepStrictEqual(artifactBlocks("```artifact\n\n```"), []);
    assert.deepStrictEqual(artifactBlocks("```artifact``` in a sentence"), []);
    assert.deepStrictEqual(artifactBlocks("```html\n```artifact\n```\n"), []);
  });

  it("extracts nested fences with the renderer's normalized content and ignores HTML comments", () => {
    const text = [
      "<!--",
      "```artifact",
      "<p>hidden</p>",
      "```",
      "-->",
      "",
      "> ```artifact",
      "> <p>quoted</p>",
      "> ```",
      "",
      "  ```artifact",
      "  <div>",
      "    content",
      "  </div>",
      "  ```",
      "",
      "- item",
      "",
      "  ```artifact",
      "  <p>listed</p>",
      "  ```",
    ].join("\n");
    assert.deepStrictEqual(artifactBlocks(text), [
      "<p>quoted</p>",
      "<div>\n  content\n</div>",
      "<p>listed</p>",
    ]);
  });

  it("requires a real closing fence, including in containers", () => {
    assert.deepStrictEqual(artifactBlocks("> ```artifact\n> <p>unfinished</p>\nnext"), []);
    assert.deepStrictEqual(artifactBlocks("```artifact\n<p>unfinished</p>\n    ```"), []);
    assert.deepStrictEqual(artifactBlocks("````artifact\n<p>x</p>\n```"), []);
    assert.deepStrictEqual(artifactBlocks("```artifact\n<p>x</p>\n``` trailing"), []);
    assert.deepStrictEqual(artifactBlocks("```artifact\n<p>x</p>\n\n```"), ["<p>x</p>\n"]);
  });

  it("does not extract fences inside a math block", () => {
    assert.deepStrictEqual(artifactBlocks("$$\n```artifact\n<p>math</p>\n```\n$$"), []);
  });

  it("decodes entities in artifact fence languages before rejecting candidates", () => {
    assert.deepStrictEqual(artifactBlocks("```artif&#97;ct\n<p>entity</p>\n```"), ["<p>entity</p>"]);
  });

  it("lists pages newest first, each once", () => {
    const messages = [
      { text: "```artifact\n<p>b</p>\n```\n```artifact\n<p>c</p>\n```", at: 2 },
      { text: "```artifact\n<p>a</p>\n```\n```artifact\n<p>b</p>\n```", at: 1 },
    ];
    const listed = newestArtifacts(messages, 10);
    assert.deepStrictEqual(
      listed.map(({ code, message }) => [code, message.at]),
      [
        ["<p>c</p>", 2],
        ["<p>b</p>", 2],
        ["<p>a</p>", 1],
      ],
    );
    assert.lengthOf(newestArtifacts(messages, 2), 2);
    assert.strictEqual(listed[0]!.id, artifactId("  <p>c</p>\n"));
    assert.notStrictEqual(artifactId("<p>c</p>"), artifactId("<p>b</p>"));
  });

  it("reads the page's title, not a script's", () => {
    assert.strictEqual(artifactTitle("<title> Run  times </title><p>x</p>"), "Run times");
    assert.isUndefined(artifactTitle("<script>const t = '<title>no</title>'</script>"));
    assert.strictEqual(
      artifactTitle('<div><h3 class="x">Before &amp; <em>after</em></h3><h2>Later</h2></div>'),
      "Before & after",
    );
    assert.strictEqual(artifactTitle("<title>Page</title><h1>Heading</h1>"), "Page");
  });
});
