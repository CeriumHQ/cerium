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
    { timeout: 90_000 },
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

  it(
    "waits for late targets and finished transitions, and copes with a page a popup hid",
    { timeout: 90_000 },
    async () => {
      const launched = await launchBrowser({ executable: browser!, visible: false, width: 800, height: 600 });
      try {
        const target = await pickPage(launched.origin);
        const page = await Page.open(target.webSocketDebuggerUrl);
        await page.navigate(`data:text/html,${encodeURIComponent(LATE)}`);

        await page.click({ text: "Appears later" }, { button: "left", count: 1 });
        assert.strictEqual(await page.evaluate("document.getElementById('log').textContent"), "clicked");

        await page.evaluate("document.getElementById('fade').classList.add('in')");
        await page.settle();
        assert.strictEqual(
          await page.evaluate("getComputedStyle(document.getElementById('fade')).opacity"),
          "1",
        );

        // A popup puts the page behind it, where it draws no frames, so settling skips them…
        await page.evaluate("void window.open('about:blank')");
        assert.strictEqual(await page.evaluate("document.visibilityState"), "hidden");
        const settling = Date.now();
        await page.settle();
        assert.isBelow(Date.now() - settling, 1_000);
        page.close();

        // …and a page in the tool's own browser comes back to the front, where input answers at once.
        const front = await Page.open(target.webSocketDebuggerUrl, { front: true });
        assert.strictEqual(await front.evaluate("document.visibilityState"), "visible");
        const hovering = Date.now();
        await front.hover({ text: "Fades in" });
        assert.isBelow(Date.now() - hovering, 1_000);
        front.close();
      } finally {
        launched.close();
      }
    },
  );

  it(
    "drags with pointer events and with native drag and drop, and holds a drag midway",
    { timeout: 90_000 },
    async () => {
      const launched = await launchBrowser({ executable: browser!, visible: false, width: 800, height: 600 });
      try {
        const page = await Page.open((await pickPage(launched.origin)).webSocketDebuggerUrl);
        await page.navigate(`data:text/html,${encodeURIComponent(DRAGS)}`);
        const log = () => page.evaluate<string>("document.getElementById('log').textContent");

        await page.drag({ text: "Native card" }, { text: "Drop here" });
        assert.strictEqual(await log(), "dropped native");

        await page.down({ text: "Pointer card" });
        await page.move({ text: "Drop here" });
        assert.isTrue(page.holding);
        assert.strictEqual(await log(), "moving");
        await page.up();
        assert.isFalse(page.holding);
        assert.strictEqual(await log(), "released over Drop here");
        page.close();
      } finally {
        launched.close();
      }
    },
  );
});

const LATE = `<!doctype html><title>Late</title>
<style>#fade { opacity: 0; transition: opacity 600ms } #fade.in { opacity: 1 }</style>
<div id="fade">Fades in</div>
<p id="log"></p>
<script>
  setTimeout(() => {
    const button = document.createElement("button");
    button.textContent = "Appears later";
    button.onclick = () => (document.getElementById("log").textContent = "clicked");
    document.body.append(button);
  }, 800);
</script>`;

const DRAGS = `<!doctype html><title>Drags</title>
<div id="native" draggable="true" style="width:120px;height:40px">Native card</div>
<div id="pointer" style="width:120px;height:40px;margin-top:20px;touch-action:none">Pointer card</div>
<div id="zone" style="width:200px;height:100px;margin:40px 0 0 300px">Drop here</div>
<p id="log"></p>
<script>
  const log = (text) => (document.getElementById("log").textContent = text);
  const zone = document.getElementById("zone");
  document.getElementById("native").addEventListener("dragstart", (event) => event.dataTransfer.setData("text/plain", "native"));
  zone.addEventListener("dragover", (event) => event.preventDefault());
  zone.addEventListener("drop", (event) => log("dropped " + event.dataTransfer.getData("text/plain")));
  const pointer = document.getElementById("pointer");
  pointer.addEventListener("pointerdown", (event) => pointer.setPointerCapture(event.pointerId));
  pointer.addEventListener("pointermove", (event) => { if (event.buttons) log("moving"); });
  pointer.addEventListener("pointerup", (event) =>
    log("released over " + document.elementFromPoint(event.clientX, event.clientY).textContent));
</script>`;
