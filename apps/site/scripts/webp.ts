// Turns a capture into the WebP the site serves, keeping its transparency: the browser's own encoder
// does the work, so nothing needs installing. A crop or a width cuts a detail out of a whole-window
// shot, or scales one down for a smaller frame.
//
//   node apps/site/scripts/webp.ts [--quality=90] [--crop=x,y,width,height] [--width=1600] <in.png> <out.webp>
//
// The crop is in the capture's own pixels.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { findBrowser, launchBrowser, Page, pickPage } from "@cerium/browser";

const options = new Map<string, string>();
const files: Array<string> = [];
for (const arg of process.argv.slice(2)) {
  const option = /^--([\w-]+)=(.*)$/s.exec(arg);
  if (option === null) files.push(arg);
  else options.set(option[1]!, option[2]!);
}
const [input, output] = files;
if (input === undefined || output === undefined) {
  console.error("webp needs <in.png> <out.webp>.");
  process.exit(1);
}
const quality = Number(options.get("quality") ?? 90) / 100;
const crop = options.get("crop")?.split(",").map(Number) ?? null;
const width = options.has("width") ? Number(options.get("width")) : null;

const executable = findBrowser();
if (executable === undefined) {
  console.error("webp needs Edge or Chrome installed.");
  process.exit(1);
}
const browser = await launchBrowser({ executable, visible: false, width: 800, height: 600 });
let failed = false;
try {
  const page = await Page.open((await pickPage(browser.origin)).webSocketDebuggerUrl);
  const png = readFileSync(resolve(input)).toString("base64");
  const webp = await page.evaluate<string>(
    `(async () => {
      const image = new Image();
      image.src = "data:image/png;base64,${png}";
      await image.decode();
      const [x, y, w, h] = ${JSON.stringify(crop)} ?? [0, 0, image.naturalWidth, image.naturalHeight];
      const scale = ${JSON.stringify(width)} === null ? 1 : ${JSON.stringify(width)} / w;
      const canvas = new OffscreenCanvas(Math.round(w * scale), Math.round(h * scale));
      const context = canvas.getContext("2d");
      context.imageSmoothingQuality = "high";
      context.drawImage(image, x, y, w, h, 0, 0, canvas.width, canvas.height);
      const blob = await canvas.convertToBlob({ type: "image/webp", quality: ${quality} });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(binary);
    })()`,
    60_000,
  );
  writeFileSync(resolve(output), Buffer.from(webp, "base64"));
  console.log(JSON.stringify({ output: resolve(output), bytes: Buffer.byteLength(webp, "base64") }));
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  browser.close();
}
process.exit(failed ? 1 : 0);
