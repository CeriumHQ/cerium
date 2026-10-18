import type { Attachment } from "@cerium/protocol";
import { Base64 } from "effect/encoding";

import { shellBridge } from "../../backend/shell.ts";

// Turning a pasted, dropped or picked file into something a message can carry: a path on disk. Files
// that already have one (copied from File Explorer) are used where they are; anything that only
// exists in memory, such as a screenshot, is saved by the backend first.

/** Images every harness takes inline. Others still travel as files. */
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Images the window can decode, and so shrink and preview. */
const RASTER_TYPES = new Set([...INLINE_IMAGE_TYPES, "image/bmp", "image/avif"]);
/** Larger images are scaled down: models see little more, and harnesses refuse big ones (Claude: 5 MB). */
const MAX_SIDE = 2000;
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const typesByExtension: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
};

export const mediaTypeOf = (file: File): string =>
  file.type ||
  typesByExtension[file.name.split(".").at(-1)?.toLowerCase() ?? ""] ||
  "application/octet-stream";

/** Whether the composer can show `file` as a thumbnail. */
export const isPreviewable = (file: File): boolean => RASTER_TYPES.has(mediaTypeOf(file));

/** The image as harnesses take it: unchanged when it already fits, otherwise a smaller PNG or JPEG. */
const fitImage = async (file: File): Promise<Blob> => {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= MAX_IMAGE_BYTES && INLINE_IMAGE_TYPES.has(mediaTypeOf(file))) {
    bitmap.close();
    return file;
  }
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const png = await canvas.convertToBlob({ type: "image/png" });
  return png.size <= MAX_IMAGE_BYTES ? png : canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
};

const withExtension = (name: string, mediaType: string) => {
  const extension = mediaType === "image/jpeg" ? "jpg" : mediaType.split("/")[1];
  return extension === undefined ? name : `${name.replace(/\.[^.]+$/, "")}.${extension}`;
};

export interface SavePayload {
  readonly name: string;
  readonly mediaType: string;
  readonly data: string;
}

/** Makes `file` sendable; `save` stores bytes that have no path of their own. Rejects with a message. */
export const prepareAttachment = async (
  file: File,
  save: (payload: SavePayload) => Promise<Attachment>,
): Promise<Attachment> => {
  const path = shellBridge()?.pathForFile?.(file);
  const mediaType = mediaTypeOf(file);
  const name = file.name || "Pasted file";
  if (RASTER_TYPES.has(mediaType)) {
    const fitted = await fitImage(file).catch(() => {
      throw new Error(`${name} couldn't be read as an image.`);
    });
    if (fitted === file && path) return { path, name, mediaType };
    const type = fitted.type || mediaType;
    return save({
      name: withExtension(name, type),
      mediaType: type,
      data: Base64.encode(new Uint8Array(await fitted.arrayBuffer())),
    });
  }
  if (path) return { path, name, mediaType };
  if (file.size > MAX_FILE_BYTES) throw new Error(`${name} is over 25 MB.`);
  return save({ name, mediaType, data: Base64.encode(new Uint8Array(await file.arrayBuffer())) });
};
