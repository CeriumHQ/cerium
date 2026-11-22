import type { Attachment } from "@cerium/protocol";
import { Base64 } from "effect/encoding";

import { shellBridge } from "../../backend/shell.ts";
import { WEB } from "../../backend/target.ts";

// Turning a pasted, dropped or picked file into something a message can carry: a path on disk. Files
// that already have one (copied from File Explorer) are used where they are; anything that only
// exists in memory, such as a screenshot, is saved by the backend first.

/** Images every harness takes inline. Others still travel as files. */
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Images the window can decode, and so shrink and preview. */
const RASTER_TYPES = new Set([...INLINE_IMAGE_TYPES, "image/bmp", "image/avif"]);
/**
 * Phones' photos, which only some browsers decode (Safari does). Decoded, they go as JPEG; otherwise
 * as the file they are.
 */
const HEIF_TYPES = new Set(["image/heic", "image/heif"]);
/** Photos, which JPEG keeps far smaller than PNG. */
const PHOTO_TYPES = new Set(["image/jpeg", ...HEIF_TYPES]);
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface ImageLimits {
  readonly maxSide: number;
  readonly maxBytes: number;
}

/**
 * Larger images are scaled down: models see little more, and harnesses refuse big ones (Claude: 5 MB).
 * The web client sends them through the relay, often over a phone's network, so it sends them smaller.
 */
export const imageLimits = (web: boolean): ImageLimits =>
  web ? { maxSide: 1600, maxBytes: 1.8 * 1024 * 1024 } : { maxSide: 2000, maxBytes: 3.5 * 1024 * 1024 };

const LIMITS = imageLimits(WEB);

export interface ImageEncoding {
  readonly type: "image/png" | "image/jpeg";
  readonly quality?: number;
}

/** The encodings a scaled image tries in turn until one fits: a photo goes straight to JPEG. */
export const imageEncodings = (mediaType: string): ReadonlyArray<ImageEncoding> => [
  ...(PHOTO_TYPES.has(mediaType) ? [] : [{ type: "image/png" } as const]),
  { type: "image/jpeg", quality: 0.88 },
  { type: "image/jpeg", quality: 0.75 },
];

const typesByExtension: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
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
  const scale = Math.min(1, LIMITS.maxSide / Math.max(bitmap.width, bitmap.height));
  const mediaType = mediaTypeOf(file);
  if (scale === 1 && file.size <= LIMITS.maxBytes && INLINE_IMAGE_TYPES.has(mediaType)) {
    bitmap.close();
    return file;
  }
  const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let blob: Blob | undefined;
  for (const encoding of imageEncodings(mediaType)) {
    blob = await canvas.convertToBlob(encoding);
    if (blob.size <= LIMITS.maxBytes) break;
  }
  return blob!;
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
  const heif = HEIF_TYPES.has(mediaType);
  if (RASTER_TYPES.has(mediaType) || heif) {
    const fitted = await fitImage(file).catch(() => {
      if (heif) return undefined;
      throw new Error(`${name} couldn't be read as an image.`);
    });
    if (fitted === undefined) return sendFile(file, name, mediaType, path, save);
    if (fitted === file && path) return { path, name, mediaType };
    const type = fitted.type || mediaType;
    return save({
      name: withExtension(name, type),
      mediaType: type,
      data: Base64.encode(new Uint8Array(await fitted.arrayBuffer())),
    });
  }
  return sendFile(file, name, mediaType, path, save);
};

/** `file` as it is: where it lies, or saved by the backend. */
const sendFile = async (
  file: File,
  name: string,
  mediaType: string,
  path: string | undefined,
  save: (payload: SavePayload) => Promise<Attachment>,
): Promise<Attachment> => {
  if (path) return { path, name, mediaType };
  if (file.size > MAX_FILE_BYTES) throw new Error(`${name} is over 25 MB.`);
  return save({ name, mediaType, data: Base64.encode(new Uint8Array(await file.arrayBuffer())) });
};
