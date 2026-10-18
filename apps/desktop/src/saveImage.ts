import { app, BrowserWindow, dialog, type WebContents } from "electron";
import { copyFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize } from "node:path";

// Saves an image the transcript shows, where the user picks with the native Save dialog.

/** The image types the transcript shows, by file extension. */
const types: Record<string, { readonly label: string; readonly extensions: ReadonlyArray<string> }> = {
  png: { label: "PNG image", extensions: ["png"] },
  jpeg: { label: "JPEG image", extensions: ["jpg", "jpeg"] },
  gif: { label: "GIF image", extensions: ["gif"] },
  webp: { label: "WebP image", extensions: ["webp"] },
  bmp: { label: "Bitmap image", extensions: ["bmp"] },
  avif: { label: "AVIF image", extensions: ["avif"] },
  svg: { label: "SVG image", extensions: ["svg"] },
};

const typeOfExtension = (extension: string) =>
  Object.keys(types).find((type) => types[type]?.extensions.includes(extension.toLowerCase()));

/**
 * Where the Save dialog opens: Pictures at first, then wherever the user last saved an image. Left to
 * Windows, a first save opens in the folder Cerium was started from.
 */
let saveFolder: string | undefined;

const DATA_URL = /^data:image\/(png|jpeg|gif|webp|bmp|avif|svg\+xml);base64,([A-Za-z0-9+/]+={0,2})$/;

/** The image's type and where its bytes come from; undefined for anything but an image. */
const imageOf = async (source: string) => {
  const data = DATA_URL.exec(source);
  if (data?.[1] !== undefined && data[2] !== undefined) {
    return { type: data[1].replace("+xml", ""), bytes: Buffer.from(data[2], "base64") };
  }
  if (!isAbsolute(source)) return undefined;
  const path = normalize(source);
  const type = typeOfExtension(extname(path).slice(1));
  const file = await stat(path).catch(() => undefined);
  return type !== undefined && file?.isFile() ? { type, path } : undefined;
};

/**
 * Asks where to save the image `source` (a base64 `data:image/…` URL or an absolute path to an
 * image file), suggesting `name`, then writes it. Resolves whether it was saved.
 */
export const saveImage = async (sender: WebContents, source: unknown, name: unknown): Promise<boolean> => {
  if (typeof source !== "string" || typeof name !== "string") return false;
  const image = await imageOf(source);
  const type = image ? types[image.type] : undefined;
  if (image === undefined || type === undefined) return false;
  const suggested = basename(name).trim() || "image";
  const fileName =
    typeOfExtension(extname(suggested).slice(1)) === image.type
      ? suggested
      : `${suggested}.${type.extensions[0]}`;
  const options = {
    defaultPath: join(saveFolder ?? app.getPath("pictures"), fileName),
    filters: [{ name: type.label, extensions: [...type.extensions] }],
  };
  const owner = BrowserWindow.fromWebContents(sender);
  const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
  if (result.canceled || result.filePath === "") return false;
  saveFolder = dirname(result.filePath);
  if ("bytes" in image) await writeFile(result.filePath, image.bytes);
  else await copyFile(image.path, result.filePath);
  return true;
};
