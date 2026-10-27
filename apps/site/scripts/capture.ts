// Captures Cerium's UI for the website as the desktop app draws it over Acrylic: the theme's glass with
// nothing painted behind it, saved as PNGs that keep their transparency, so the site can lay its own
// light behind the window and the glass shows as glass.
//
// It drives the UI's dev server against a backend of your choosing, so the pictures show staged
// showcase threads rather than your own:
//
//   node apps/backend/src/main.ts --data-dir=<dir> --connection-file=<dir>/connection.json
//   node apps/site/scripts/capture.ts --connection=<dir>/connection.json [options] <step>...
//
//   --ui=<url>          the UI's dev server (default: the one .cerium-dev/ui-url names, else :5173)
//   --folder=<path>     what the folder prompt answers when a step starts a work thread
//   --size=1440x900     the window, in CSS pixels
//   --scale=2           device pixels per CSS pixel
//   --theme=dark|light  the mode the app is in
//   --palette=<id>      the app's theme (cerium, amber, uranium, seaglass, cobalt, cranberry)
//   --opaque            paint the theme's own backdrop, as on a phone, which has no Acrylic
//   --out=<dir>         where shots go (default: a cerium-site-capture folder in the temp directory)
//   --format=png|webp   webp keeps the transparency at a tenth of the size, for the site itself
//   --clock=<iso time>  the time the app believes it is, so a reshoot's "10m ago" reads as the first did
//
// Steps are `bun run ui act`'s. `shot=<name>` saves <out>/<name>.png of the whole window and
// `shot@<target>=<name>` of one element; `script=<file>` runs a file of JavaScript in the page, to mark
// the elements a shot crops to, say.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { findBrowser, launchBrowser, Page, parseStep, pickPage, runStep } from "@cerium/browser";

const root = join(import.meta.dirname, "..", "..", "..");
const options = new Map<string, string>();
const steps: Array<string> = [];
for (const arg of process.argv.slice(2)) {
  const option = /^--([\w-]+)(?:=(.*))?$/s.exec(arg);
  if (option === null) steps.push(arg);
  else options.set(option[1]!, option[2] ?? "");
}

const connectionFile = options.get("connection");
if (connectionFile === undefined) {
  console.error("capture needs --connection=<the showcase backend's connection.json>.");
  process.exit(1);
}
const connection = JSON.parse(readFileSync(resolve(connectionFile), "utf8")) as {
  url: string;
  token: string;
};
const devUrlFile = join(root, ".cerium-dev", "ui-url");
const ui =
  options.get("ui") ||
  (existsSync(devUrlFile) ? readFileSync(devUrlFile, "utf8").trim() : "") ||
  "http://localhost:5173";
const [width, height] = (options.get("size") ?? "1440x900").split("x").map(Number) as [number, number];
const scale = Number(options.get("scale") ?? 2);
const theme = options.get("theme") === "light" ? "light" : "dark";
const palette = options.get("palette") ?? "cerium";
const glass = !options.has("opaque");
const out = resolve(options.get("out") ?? join(tmpdir(), "cerium-site-capture"));
const format = options.get("format") === "webp" ? "webp" : "png";
const clock = options.has("clock") ? Date.parse(options.get("clock")!) : null;
if (clock !== null && Number.isNaN(clock)) {
  console.error("capture's --clock needs a time Date.parse reads, like 2026-10-23T02:09+03:00.");
  process.exit(1);
}
mkdirSync(out, { recursive: true });

// Runs before the app: hands it the showcase backend, answers the folder prompt, picks the theme, and,
// in Cerium's own theme, paints nothing behind the window, as Electron leaves the page for Acrylic.
// The other themes paint their own backdrop there too, so they keep it. The browser preview's
// stand-in caption buttons stay, so the titlebar keeps the room Windows' own take.
const prelude = `(() => {
  const connection = ${JSON.stringify(connection)};
  const folder = ${JSON.stringify(options.get("folder") ?? "")};
  localStorage.setItem("cerium:theme", ${JSON.stringify(theme)});
  localStorage.setItem("cerium:palette", ${JSON.stringify(palette)});
  const fetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (url.endsWith("/__cerium/connection")) {
      return Promise.resolve(new Response(JSON.stringify(connection), { headers: { "content-type": "application/json" } }));
    }
    return fetch(input, init);
  };
  window.prompt = () => folder;
  const clock = ${JSON.stringify(clock)};
  if (clock !== null) {
    const offset = clock - Date.now();
    const RealDate = Date;
    window.Date = class extends RealDate {
      constructor(...args) {
        super(...(args.length === 0 ? [RealDate.now() + offset] : args));
      }
      static now() {
        return RealDate.now() + offset;
      }
    };
  }
  const style = document.createElement("style");
  // A dark color-scheme on the root paints the canvas dark, which no background override clears.
  style.textContent = ${glass} ? \`
    html[data-shell][data-palette="cerium"] { color-scheme: light !important; }
    html[data-shell][data-palette="cerium"] body { background: transparent !important; }
    html[data-shell][data-palette="cerium"] #root::before { display: none !important; }
    html[data-shell][data-palette="cerium"][data-theme="dark"] { --window-alpha: 0.45; }
  \` : "";
  // The document has no element yet when this runs.
  document.addEventListener("DOMContentLoaded", () => document.head.append(style));
})();`;

const executable = findBrowser();
if (executable === undefined) {
  console.error("capture needs Edge or Chrome installed.");
  process.exit(1);
}
const browser = await launchBrowser({ executable, visible: false, width, height });
let failed = false;
try {
  const target = await pickPage(browser.origin);
  const page = await Page.open(target.webSocketDebuggerUrl);
  await page.viewport({ width, height, scale, mobile: false });
  await page.colorScheme(theme);
  await page.cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  await page.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: prelude });
  await page.navigate(ui);
  await page.settle(1_500);

  for (const arg of steps) {
    if (arg.startsWith("script=")) {
      const value = await page.evaluate(readFileSync(resolve(arg.slice("script=".length)), "utf8"));
      await page.settle();
      console.log(JSON.stringify({ step: arg, value: value ?? null }));
      continue;
    }
    for (const step of parseStep(arg)) {
      if (step.action !== "shot") {
        const result = await runStep(page, step);
        await page.settle();
        console.log(JSON.stringify({ step: arg, ...result }));
        continue;
      }
      await page.settle(400);
      let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
      if (step.target !== undefined) {
        const found = await page.find(step.target);
        clip = {
          x: found.x - found.width / 2,
          y: found.y - found.height / 2,
          width: found.width,
          height: found.height,
          scale: 1,
        };
      }
      const shot = (await page.cdp.send("Page.captureScreenshot", {
        format,
        ...(format === "webp" ? { quality: 90 } : {}),
        ...(clip === undefined ? {} : { clip }),
      })) as { data: string };
      const file = join(out, `${step.value ?? "shot"}.${format}`);
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      console.log(JSON.stringify({ step: arg, screenshot: file }));
    }
  }
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  // Waited for: exiting first would leave the browser running.
  await browser.close();
}
process.exit(failed ? 1 : 0);
