import { assert, describe, it } from "@effect/vitest";

import { describePage } from "../src/agent.ts";
import { isLocalUrl, localUrlsIn, previewUrl } from "../src/url.ts";

describe("preview addresses", () => {
  it("open local hosts over http and others over https", () => {
    assert.strictEqual(previewUrl("localhost:5173"), "http://localhost:5173/");
    assert.strictEqual(previewUrl("127.0.0.1:3000/app?x=1"), "http://127.0.0.1:3000/app?x=1");
    assert.strictEqual(previewUrl("example.com"), "https://example.com/");
    assert.strictEqual(previewUrl("  http://localhost:8080/a  "), "http://localhost:8080/a");
    assert.strictEqual(previewUrl("http://0.0.0.0:4321/"), "http://localhost:4321/");
  });

  it("refuse every scheme but http and https", () => {
    for (const url of [
      "file:///C:/secret.txt",
      "javascript:alert(1)",
      "data:text/html,hi",
      "ftp://x.org",
      "",
    ]) {
      assert.isUndefined(previewUrl(url), url);
    }
  });

  it("know a dev server's own addresses", () => {
    assert.isTrue(isLocalUrl("http://localhost:5173/"));
    assert.isTrue(isLocalUrl("http://[::1]:3000/"));
    assert.isFalse(isLocalUrl("https://example.com/"));
    assert.isFalse(isLocalUrl("http://localhost.example.com/"));
  });

  it("find a dev server's addresses in what it prints", () => {
    assert.deepStrictEqual(localUrlsIn("  ➜  Local:   http://localhost:5173/"), ["http://localhost:5173/"]);
    assert.deepStrictEqual(localUrlsIn("ready on http://127.0.0.1:3000, see https://nextjs.org/docs."), [
      "http://127.0.0.1:3000/",
    ]);
    assert.deepStrictEqual(localUrlsIn("Network: use --host to expose"), []);
  });
});

describe("a page as an agent reads it", () => {
  it("lists each control at its centre, with its states and value", () => {
    const text = describePage({
      url: "http://localhost:5173/",
      title: "Todo",
      viewport: [800, 600],
      scroll: [0, 120],
      elements: [
        { role: "textbox", name: "New todo", box: [10, 20, 200, 30], value: "milk", states: ["focused"] },
        { role: "button", name: "Add", box: [220, 20, 60, 30] },
      ],
      text: "Todo\nmilk",
    });
    assert.include(text, "Page: Todo — http://localhost:5173/");
    assert.include(text, "scrolled to 0,120");
    assert.include(text, '- textbox "New todo" value="milk" (focused) @110,35');
    assert.include(text, '- button "Add" @250,35');
    assert.include(text, "Text:\nTodo\nmilk");
  });
});
