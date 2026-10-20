import { findBrowser, launchBrowser, Page, pickPage } from "@cerium/browser";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { artifactDocument, fontFaces } from "./document.ts";
import { ARTIFACT_MAX_HEIGHT } from "./limits.ts";
import { BACKDROPS, DEFAULT_THEMES, type ArtifactMode } from "./theme.ts";

// Renders an artifact the way the conversation will, in the user's own Edge or Chrome without a
// window, so an agent can look at its page before it replies. Node only: exported from
// `@cerium/artifacts/preview`, apart from what the UI imports.

export interface ArtifactPreview {
  readonly png: Uint8Array;
  readonly width: number;
  /** The height the page needs at this width, which its frame in the conversation takes. */
  readonly contentHeight: number;
  /** Whether the page grew when its frame did: a height in `vh` or `100%` that never settles. */
  readonly growsWithFrame: boolean;
  /** Console output, uncaught errors and what the browser refused or failed to load. */
  readonly console: ReadonlyArray<{ readonly level: string; readonly text: string }>;
}

export class ArtifactPreviewError extends Error {}

/** The app's fonts as `data:` URLs, when their packages are installed beside this one. */
const appFonts = (() => {
  let faces: string | undefined | null = null;
  return (): string | undefined => {
    if (faces !== null) return faces;
    try {
      const require = createRequire(import.meta.url);
      const read = (file: string) =>
        `data:font/woff2;base64,${readFileSync(require.resolve(file)).toString("base64")}`;
      faces = fontFaces({
        sans: read("@fontsource-variable/red-hat-text/files/red-hat-text-latin-wght-normal.woff2"),
        mono: read("@fontsource-variable/red-hat-mono/files/red-hat-mono-latin-wght-normal.woff2"),
      });
    } catch {
      faces = undefined;
    }
    return faces;
  };
})();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const MEASURE = `(() => {
  const root = document.documentElement;
  return Math.ceil(root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height);
})()`;

const rgba = (hex: string) => ({
  r: Number.parseInt(hex.slice(1, 3), 16),
  g: Number.parseInt(hex.slice(3, 5), 16),
  b: Number.parseInt(hex.slice(5, 7), 16),
  a: 1,
});

export const previewArtifact = async (input: {
  readonly html: string;
  readonly width: number;
  readonly mode: ArtifactMode;
}): Promise<ArtifactPreview> => {
  const executable = findBrowser();
  if (executable === undefined) {
    throw new ArtifactPreviewError(
      "Previews need Microsoft Edge or Google Chrome, and neither is installed.",
    );
  }
  const folder = mkdtempSync(join(tmpdir(), "cerium-artifact-"));
  const file = join(folder, "artifact.html");
  writeFileSync(file, artifactDocument(input.html, { theme: DEFAULT_THEMES[input.mode], fonts: appFonts() }));
  const browser = await launchBrowser({ executable, visible: false, width: input.width, height: 800 });
  let page: Page | undefined;
  try {
    page = await Page.open((await pickPage(browser.origin)).webSocketDebuggerUrl);
    const loads: Array<{ level: string; text: string }> = [];
    page.cdp.on("Log.entryAdded", (event) => {
      const entry = event.entry ?? {};
      if (entry.level === "error" || entry.level === "warning") {
        loads.push({ level: entry.level, text: String(entry.text ?? "").slice(0, 500) });
      }
    });
    await page.cdp.send("Log.enable");
    await page.viewport({ width: input.width, height: 800, scale: 1, mobile: false });
    await page.cdp.send("Emulation.setDefaultBackgroundColorOverride", {
      color: rgba(BACKDROPS[input.mode]),
    });
    // A slow CDN only delays the load event; the page is measured as it stands.
    await page.navigate(pathToFileURL(file).href, 15_000).catch(() => undefined);
    await sleep(400);
    const first = await page.evaluate<number>(MEASURE);
    // The conversation's frame takes the page's height, so the page is measured again at it.
    const frame = Math.max(1, Math.min(first, ARTIFACT_MAX_HEIGHT));
    await page.viewport({ width: input.width, height: frame, scale: 1, mobile: false });
    await page.settle(250);
    const second = await page.evaluate<number>(MEASURE);
    const contentHeight = Math.min(second, ARTIFACT_MAX_HEIGHT);
    if (contentHeight !== frame) {
      await page.viewport({
        width: input.width,
        height: Math.max(1, contentHeight),
        scale: 1,
        mobile: false,
      });
      await page.settle(150);
    }
    const png = await page.screenshot({ fullPage: false });
    return {
      png,
      width: input.width,
      contentHeight,
      growsWithFrame: second > first + 2,
      console: [...page.drainConsole(), ...loads].slice(0, 50),
    };
  } finally {
    page?.close();
    browser.close();
    rmSync(folder, { recursive: true, force: true });
  }
};
