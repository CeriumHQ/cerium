import { assert, describe, it } from "@effect/vitest";
import { Script } from "node:vm";

import {
  artifactDocument,
  artifactGuide,
  artifactHostPage,
  DEFAULT_THEMES,
  isLegacyArtifact,
  readFrameMessage,
  THEME_TOKENS,
  themeFromTokens,
  themeUpdate,
} from "../src/index.ts";

const theme = DEFAULT_THEMES.dark;

describe("artifact guide", () => {
  it("names only variables a page gets", () => {
    const fixed = ["--radius", "--radius-sm", "--font-sans", "--font-mono"];
    const known = new Set([...Object.keys(THEME_TOKENS), ...fixed]);
    const spans = [...artifactGuide.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);
    const named = spans.flatMap((span) => [...span.matchAll(/--[a-z][a-z0-9-]*/g)].map((match) => match[0]));
    assert.isNotEmpty(named);
    for (const name of named) {
      assert.isTrue(known.has(name), `${name} isn't a variable the page gets`);
    }
  });
});

describe("themes", () => {
  it("give every variable in both modes", () => {
    for (const mode of ["dark", "light"] as const) {
      assert.deepStrictEqual(
        Object.keys(DEFAULT_THEMES[mode].variables).toSorted(),
        Object.keys(THEME_TOKENS).toSorted(),
      );
    }
  });

  it("read from the window's tokens", () => {
    const read = themeFromTokens("light", (token) => ` value of ${token} `);
    assert.strictEqual(read.variables["--chart-3"], "value of --series-3");
    assert.strictEqual(read.mode, "light");
  });

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

  it("adds a doctype to a document without one", () => {
    assert.match(artifactDocument("<html><body>x</body></html>", { theme }), /^<!doctype html><html><head>/);
  });

  it("ignores a head written inside a script or a comment", () => {
    const page = "<!-- <head> --><p>x</p><script>const tag = '<head>';</script>";
    const html = artifactDocument(page, { theme });
    assert.match(html, /^<!doctype html>\n<html><head>/);
    assert.include(html, "const tag = '<head>';");
  });

  it("serializes a runtime that stands on its own", () => {
    const html = artifactDocument("<p>x</p>", { theme });
    const script = /<script>(\(function[\s\S]*?)<\/script>/.exec(html)?.[1];
    assert.isDefined(script);
    // Parsed, not run: the serialized runtime must be JavaScript the frame can run as it is.
    assert.doesNotThrow(() => new Script(script!));
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
  });
});
