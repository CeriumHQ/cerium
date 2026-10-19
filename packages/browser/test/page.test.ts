import { assert, describe, it } from "@effect/vitest";

import { findBrowser, launchBrowser, pickPage } from "../src/browser.ts";
import { Page, parseKeys } from "../src/page.ts";

describe("key presses", () => {
  it("parse named keys, characters and modifier combinations", () => {
    assert.deepInclude(parseKeys("Enter"), { key: "Enter", keyCode: 13, text: "\r", modifiers: 0 });
    assert.deepInclude(parseKeys("Shift+Tab"), { key: "Tab", modifiers: 8 });
    assert.deepInclude(parseKeys("Control+K"), { key: "K", code: "KeyK", keyCode: 75, modifiers: 2 });
    assert.isUndefined(parseKeys("Control+K").text);
    assert.deepInclude(parseKeys("a"), { key: "a", code: "KeyA", text: "a", modifiers: 0 });
    assert.deepInclude(parseKeys("F5"), { key: "F5", keyCode: 116 });
    assert.deepInclude(parseKeys("Control++"), { key: "+", modifiers: 2 });
    assert.throws(() => parseKeys("Hyper+A"), 'Unknown modifier "Hyper"');
    assert.throws(() => parseKeys("Banana"), 'Unknown key "Banana"');
  });
});

const browser = findBrowser();

const FIXTURE = `<!doctype html><title>Fixture</title>
<button aria-label="Close dialog">x</button>
<div><button id="go"><span>Send</span></button><button>Send later</button></div>
<input placeholder="Message" id="box">
<p id="out"></p>
<script>
  document.getElementById("go").onclick = () => (document.getElementById("out").textContent = "sent " + document.getElementById("box").value);
  document.getElementById("box").addEventListener("keydown", (event) => { if (event.key === "Enter") document.getElementById("out").textContent = "entered"; });
</script>`;

describe.skipIf(browser === undefined)("a driven page", () => {
  it(
    "finds controls by text and name, types, presses keys and takes screenshots",
    { timeout: 60_000 },
    async () => {
      const launched = await launchBrowser({ executable: browser!, visible: false, width: 800, height: 600 });
      try {
        const page = await Page.open((await pickPage(launched.origin)).webSocketDebuggerUrl);
        await page.navigate(`data:text/html,${encodeURIComponent(FIXTURE)}`);

        // The exact match beats "Send later", and the button wins over the text inside it.
        assert.strictEqual((await page.find({ text: "send" })).label, 'button "Send"');
        assert.strictEqual((await page.find({ text: "Close dialog" })).label, 'button "Close dialog"');
        assert.strictEqual((await page.find({ text: "Send", nth: 0 })).matches, 1);

        await page.type("hello", { text: "Message" });
        await page.click({ text: "Send" }, { button: "left", count: 1 });
        assert.strictEqual(await page.evaluate("document.getElementById('out').textContent"), "sent hello");

        await page.click({ selector: "#box" }, { button: "left", count: 1 });
        await page.press(parseKeys("Enter"));
        await page.waitFor({ text: "entered" }, { gone: false, timeoutMs: 2_000 });

        const inspected = (await page.inspect(true)) as { title: string; elements: Array<{ name: string }> };
        assert.strictEqual(inspected.title, "Fixture");
        assert.include(
          inspected.elements.map((element) => element.name),
          "Send later",
        );

        const png = await page.screenshot({ fullPage: false });
        assert.deepStrictEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
        const cropped = await page.screenshot({ fullPage: false, of: { text: "Send later" } });
        assert.isBelow(cropped.length, png.length);

        const missing = await page.find({ text: "Nowhere" }).then(
          () => "found",
          (error: Error) => error.message,
        );
        assert.strictEqual(missing, 'Nothing visible matches "Nowhere".');
        page.close();
      } finally {
        launched.close();
      }
    },
  );
});
