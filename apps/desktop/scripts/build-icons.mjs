// Draws Cerium's app icon and the installer's artwork from the mark the UI's titlebar shows
// (apps/ui/src/components/CeriumMark.tsx), into apps/desktop/build/, and the web client's Home Screen
// icons into apps/ui/web/. The results are committed; run this only when the mark or the artwork
// changes:
//
//   bun run --cwd apps/desktop icons
//
// It runs inside Electron because Chromium is the one SVG and text rasteriser the repo already has.

import { app, BrowserWindow, nativeImage } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = join(import.meta.dirname, "..", "build");
const web = join(import.meta.dirname, "..", "..", "ui", "web");

// The chrome's near-black and near-white (apps/ui/src/styles/tokens.css, dark theme).
const INK = "#171717";
const INK_LIFT = "#262626";
const PAPER = "#f2f2f2";

/** The mark on a 48-unit grid, drawn like CeriumMark: heavier below 24px so it stays legible. */
const mark = (size, color) => {
  const small = size < 24;
  return `<path d="M34.6 13.4A15 15 0 1 0 34.6 34.6" stroke="${color}" stroke-width="${small ? 7 : 6}" stroke-linecap="round" fill="none"/>
    <path d="${small ? "M36 18.5 41.5 24 36 29.5 30.5 24Z" : "M36 19.5 40.5 24 36 28.5 31.5 24Z"}" fill="${color}"/>`;
};

/** The app icon: the mark, centred on a rounded dark tile with a faint lift at the top. */
const tile = (
  size,
) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${INK_LIFT}"/><stop offset="1" stop-color="${INK}"/>
  </linearGradient></defs>
  <rect x="1" y="1" width="46" height="46" rx="11" fill="url(#g)"/>
  <rect x="1.5" y="1.5" width="45" height="45" rx="10.5" fill="none" stroke="#ffffff" stroke-opacity="0.1"/>
  <g transform="translate(24 24) scale(0.78) translate(-24.5 -24)">${mark(size, PAPER)}</g>
</svg>`;

/**
 * The Mac's app icon: the same tile on Apple's icon grid, a rounded square 824 units across on a
 * 1024 canvas, with the soft shadow the Dock's other icons cast.
 */
const macTile = (
  size,
) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${INK_LIFT}"/><stop offset="1" stop-color="${INK}"/>
    </linearGradient>
    <filter id="s" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000000" flood-opacity="0.3"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#g)" filter="url(#s)"/>
  <rect x="104" y="104" width="816" height="816" rx="181" fill="none" stroke="#ffffff" stroke-opacity="0.1" stroke-width="6"/>
  <g transform="translate(512 512) scale(14) translate(-24.5 -24)">${mark(size, PAPER)}</g>
</svg>`;

/**
 * The menu bar's icon: the mark alone in black on clear, a template image macOS tints to the bar's
 * own colour, light or dark.
 */
const trayTemplate = (
  size,
) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48">
  <g transform="translate(24 24) scale(1.05) translate(-24.5 -24)">${mark(size, "#000000")}</g>
</svg>`;

/**
 * The Home Screen's icon: full-bleed, since iOS and Android cut their own shape. Android's maskable
 * icon keeps the mark smaller, inside the safe zone its masks never cut.
 */
const bleed = (
  size,
  scale,
) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${INK_LIFT}"/><stop offset="1" stop-color="${INK}"/>
  </linearGradient></defs>
  <rect width="48" height="48" fill="url(#g)"/>
  <g transform="translate(24 24) scale(${scale}) translate(-24.5 -24)">${mark(size, PAPER)}</g>
</svg>`;

app.disableHardwareAcceleration();

const window = () => new BrowserWindow({ show: false, webPreferences: { offscreen: true } });

/** Runs `draw(ctx, w, h)` on a canvas in the page and returns the PNG bytes. */
const render = async (page, width, height, svgs, draw) => {
  const dataUrl = await page.webContents.executeJavaScript(`(async () => {
    const load = (src) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
    const images = await Promise.all(${JSON.stringify(svgs)}.map((svg) => load("data:image/svg+xml;base64," + btoa(svg))));
    const canvas = document.createElement("canvas");
    canvas.width = ${width};
    canvas.height = ${height};
    const ctx = canvas.getContext("2d");
    (${draw.toString()})(ctx, ${width}, ${height}, images);
    return canvas.toDataURL("image/png");
  })()`);
  return nativeImage.createFromDataURL(dataUrl);
};

/** A 24-bit bottom-up BMP, the only image format NSIS' installer pages take. */
const bmp = (image) => {
  const { width, height } = image.getSize();
  const pixels = image.toBitmap(); // BGRA, top-down
  const stride = Math.ceil((width * 3) / 4) * 4;
  const data = Buffer.alloc(54 + stride * height);
  data.write("BM");
  data.writeUInt32LE(data.length, 2);
  data.writeUInt32LE(54, 10);
  data.writeUInt32LE(40, 14);
  data.writeInt32LE(width, 18);
  data.writeInt32LE(height, 22);
  data.writeUInt16LE(1, 26);
  data.writeUInt16LE(24, 28);
  data.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      const to = 54 + (height - 1 - y) * stride + x * 3;
      data[to] = pixels[from];
      data[to + 1] = pixels[from + 1];
      data[to + 2] = pixels[from + 2];
    }
  }
  return data;
};

/** An .ico holding one PNG per size, which Windows has read since Vista. */
const ico = (images) => {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, png }, index) => {
    const at = 6 + 16 * index;
    head[at] = size === 256 ? 0 : size;
    head[at + 1] = size === 256 ? 0 : size;
    head.writeUInt16LE(1, at + 4);
    head.writeUInt16LE(32, at + 6);
    head.writeUInt32LE(png.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...images.map(({ png }) => png)]);
};

const font = `"Segoe UI Variable Display", "Segoe UI", sans-serif`;

/** The welcome and finish pages' left panel (164x314): the mark over the name, on the tile's ink. */
const sidebar = (page) =>
  render(page, 164, 314, [tile(256)], (ctx, w, h, [icon]) => {
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, "#262626");
    gradient.addColorStop(1, "#111111");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(icon, (w - 96) / 2, 74, 96, 96);
    ctx.fillStyle = "#f2f2f2";
    ctx.textAlign = "center";
    ctx.font = `600 22px ${FONT}`;
    ctx.fillText("Cerium", w / 2, 212);
  });

/** The banner across the inner pages (150x57), on the white NSIS paints them with. */
const header = (page) =>
  render(page, 150, 57, [tile(256)], (ctx, w, h, [icon]) => {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(icon, w - 48 - 6, (h - 48) / 2, 48, 48);
  });

void app.whenReady().then(async () => {
  const page = window();
  // The renderer can't see this module's constants, so the font goes in as a page global.
  await page.loadURL(`data:text/html,<script>var FONT = ${JSON.stringify(font)};</script>`);
  mkdirSync(out, { recursive: true });

  const png = async (size, svg = tile(size)) => {
    const image = await render(page, size, size, [svg], (ctx, w, h, [icon]) => {
      ctx.drawImage(icon, 0, 0, w, h);
    });
    return image.toPNG();
  };

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = await Promise.all(sizes.map(async (size) => ({ size, png: await png(size) })));
  writeFileSync(join(out, "icon.ico"), ico(images));
  // The window's own icon, and the base for other platforms' formats.
  writeFileSync(join(out, "icon.png"), await png(512));
  // electron-builder turns this into the Mac app's .icns.
  writeFileSync(join(out, "icon-mac.png"), await png(1024, macTile(1024)));
  // The menu bar's 16-point icon, and the one Retina screens take.
  writeFileSync(join(out, "trayTemplate.png"), await png(16, trayTemplate(16)));
  writeFileSync(join(out, "trayTemplate@2x.png"), await png(32, trayTemplate(32)));

  writeFileSync(join(out, "installerSidebar.bmp"), bmp(await sidebar(page)));
  writeFileSync(join(out, "installerHeader.bmp"), bmp(await header(page)));

  mkdirSync(web, { recursive: true });
  writeFileSync(join(web, "apple-touch-icon.png"), await png(180, bleed(180, 0.68)));
  writeFileSync(join(web, "icon-192.png"), await png(192));
  writeFileSync(join(web, "icon-512.png"), await png(512));
  writeFileSync(join(web, "icon-maskable-512.png"), await png(512, bleed(512, 0.6)));

  console.log(`Wrote icons and installer artwork to ${out}, and Home Screen icons to ${web}`);
  app.quit();
});
