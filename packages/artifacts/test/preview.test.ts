import { findBrowser } from "@cerium/browser";
import { assert, describe, it } from "@effect/vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { previewArtifact } from "../src/preview.ts";

/** A 1×1 PNG. */
const DOT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

describe.skipIf(findBrowser() === undefined)("previewArtifact", () => {
  it("draws the page at the column's width and reports its height and errors", async () => {
    const preview = await previewArtifact({
      html: '<style>.box { height: 240px; background: var(--chart-1); }</style><div class="box"></div><script>missing()</script>',
      width: 400,
      mode: "dark",
    });
    assert.strictEqual(preview.width, 400);
    assert.strictEqual(preview.contentHeight, 240);
    assert.isFalse(preview.growsWithFrame);
    assert.isTrue(preview.console.some((entry) => /missing is not defined/.test(entry.text)));
    // A PNG's signature.
    assert.deepStrictEqual([...preview.png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });

  it("says when the page grows with its frame", async () => {
    const preview = await previewArtifact({
      html: '<div style="height: 100vh"></div><p>x</p>',
      width: 400,
      mode: "light",
    });
    assert.isTrue(preview.growsWithFrame);
  });

  it("embeds the local files the page names, and says which it couldn't", async () => {
    const folder = mkdtempSync(join(tmpdir(), "cerium-preview-test-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "cerium-preview-test-"));
    try {
      writeFileSync(join(elsewhere, "dot.png"), DOT);
      writeFileSync(join(folder, "inside.csv"), "a,b");
      writeFileSync(join(elsewhere, "outside.csv"), "c,d");
      // A link in the folder leading out of it.
      symlinkSync(elsewhere, join(folder, "linked"), "junction");
      const preview = await previewArtifact({
        html: `<script>
          const image = new Image();
          image.onload = () => console.log("image", image.naturalWidth);
          image.src = ${JSON.stringify(join(elsewhere, "dot.png"))};
          fetch(${JSON.stringify(join(folder, "inside.csv"))})
            .then((response) => response.text())
            .then((text) => console.log("data", text));
        </script>
        <img src="${join(elsewhere, "missing.png")}"><a href="${join(elsewhere, "outside.csv")}">data</a>
        <a href="${join(folder, "linked", "outside.csv")}">linked</a>`,
        width: 400,
        mode: "dark",
        folder,
      });
      const texts = preview.console.map((entry) => entry.text);
      // Images from anywhere, data files from the thread's folder only.
      assert.include(texts, "image 1");
      assert.include(texts, "data a,b");
      assert.include(texts, `Couldn't embed the local file ${join(elsewhere, "missing.png")}: ENOENT`);
      assert.include(
        texts,
        `Couldn't embed the local file ${join(elsewhere, "outside.csv")}: Error: data files are embedded only from the thread's folder`,
      );
      assert.include(
        texts,
        `Couldn't embed the local file ${join(folder, "linked", "outside.csv")}: Error: data files are embedded only from the thread's folder`,
      );
    } finally {
      rmSync(folder, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
