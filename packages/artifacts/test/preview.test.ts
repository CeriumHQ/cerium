import { findBrowser } from "@cerium/browser";
import { assert, describe, it } from "@effect/vitest";

import { previewArtifact } from "../src/preview.ts";

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
});
