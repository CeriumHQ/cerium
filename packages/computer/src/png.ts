import { promisify } from "node:util";
import { constants, deflate, inflate } from "node:zlib";

const inflated = promisify(inflate);
const deflated = promisify(deflate);

// Screenshots come back at the display's full resolution (a 4K screen is a ~2.5 MB PNG), which costs
// a model far more than it can use. This shrinks one to fit a bound, averaging each output pixel over
// the pixels it covers so text stays as legible as the size allows. Only 8-bit RGB and RGBA without
// interlacing, which is what agent-desktop writes; anything else is left as it is.

export interface Scaled {
  readonly png: Buffer;
  readonly width: number;
  readonly height: number;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

interface Decoded {
  readonly width: number;
  readonly height: number;
  /** Bytes per pixel: 3 for RGB, 4 for RGBA. */
  readonly channels: number;
  readonly pixels: Uint8Array;
}

const decode = async (png: Buffer): Promise<Decoded | undefined> => {
  if (png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE)) return undefined;
  let offset = 8;
  let header: { width: number; height: number; channels: number } | undefined;
  const data: Array<Buffer> = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      const [depth, color, , , interlace] = body.subarray(8, 13);
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) return undefined;
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), channels: color === 6 ? 4 : 3 };
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
  }
  if (header === undefined || data.length === 0) return undefined;
  const { width, height, channels } = header;
  const raw = await inflated(Buffer.concat(data));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return undefined;
  const pixels = new Uint8Array(height * stride);
  // One tight loop per filter: a typed array keeps the low byte of each sum, as PNG wants.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    const above = row - stride;
    const first = y === 0;
    if (filter === 0 || (filter === 2 && first)) {
      pixels.set(raw.subarray(source, source + stride), row);
    } else if (filter === 1 || (filter === 4 && first)) {
      for (let i = 0; i < channels; i++) pixels[row + i] = raw[source + i]!;
      for (let i = channels; i < stride; i++)
        pixels[row + i] = raw[source + i]! + pixels[row + i - channels]!;
    } else if (filter === 2) {
      for (let i = 0; i < stride; i++) pixels[row + i] = raw[source + i]! + pixels[above + i]!;
    } else if (filter === 3 && first) {
      for (let i = 0; i < channels; i++) pixels[row + i] = raw[source + i]!;
      for (let i = channels; i < stride; i++)
        pixels[row + i] = raw[source + i]! + (pixels[row + i - channels]! >> 1);
    } else if (filter === 3) {
      for (let i = 0; i < channels; i++) pixels[row + i] = raw[source + i]! + (pixels[above + i]! >> 1);
      for (let i = channels; i < stride; i++) {
        pixels[row + i] = raw[source + i]! + ((pixels[row + i - channels]! + pixels[above + i]!) >> 1);
      }
    } else if (filter === 4) {
      for (let i = 0; i < channels; i++) pixels[row + i] = raw[source + i]! + pixels[above + i]!;
      for (let i = channels; i < stride; i++) {
        pixels[row + i] =
          raw[source + i]! +
          paeth(pixels[row + i - channels]!, pixels[above + i]!, pixels[above + i - channels]!);
      }
    } else return undefined;
  }
  return { width, height, channels, pixels };
};

/** RGB pixels as a PNG, each row filtered (Sub, Up or Paeth) the way that leaves the least to compress. */
const encode = async (width: number, height: number, rgb: Uint8Array): Promise<Buffer> => {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  const candidates = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)] as const;
  const [sub, up, paethRow] = candidates;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const above = row - stride;
    let subCost = 0;
    let upCost = 0;
    let paethCost = 0;
    for (let i = 0; i < stride; i++) {
      const value = rgb[row + i]!;
      const left = i >= 3 ? rgb[row + i - 3]! : 0;
      const over = y > 0 ? rgb[above + i]! : 0;
      const corner = y > 0 && i >= 3 ? rgb[above + i - 3]! : 0;
      const a = (value - left) & 0xff;
      const b = (value - over) & 0xff;
      const c = (value - paeth(left, over, corner)) & 0xff;
      sub[i] = a;
      up[i] = b;
      paethRow[i] = c;
      subCost += a < 128 ? a : 256 - a;
      upCost += b < 128 ? b : 256 - b;
      paethCost += c < 128 ? c : 256 - c;
    }
    const best = subCost <= upCost && subCost <= paethCost ? 0 : upCost <= paethCost ? 1 : 2;
    raw[y * (stride + 1)] = [1, 2, 4][best]!;
    candidates[best].copy(raw, y * (stride + 1) + 1);
  }
  const chunk = (type: string, body: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
    const out = Buffer.alloc(typed.length + 8);
    out.writeUInt32BE(body.length, 0);
    typed.copy(out, 4);
    out.writeUInt32BE(crc32(typed), typed.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    // Run-length matching suits screenshots' flat runs: as small as the default, in half the time.
    chunk("IDAT", await deflated(raw, { level: 6, strategy: constants.Z_RLE })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

/**
 * `png` shrunk to fit within `maxWidth` by `maxHeight`, keeping its proportions; undefined when it
 * already fits or isn't a PNG this reads.
 */
export const fitPng = async (
  png: Buffer,
  maxWidth: number,
  maxHeight: number,
): Promise<Scaled | undefined> => {
  const image = await decode(png);
  if (image === undefined) return undefined;
  const { width, height, channels, pixels } = image;
  const factor = Math.max(width / maxWidth, height / maxHeight);
  if (factor <= 1) return undefined;
  const outWidth = Math.max(1, Math.round(width / factor));
  const outHeight = Math.max(1, Math.round(height / factor));
  const out = new Uint8Array(outWidth * outHeight * 3);
  // Each output column's span of source columns, worked out once.
  const starts = new Int32Array(outWidth);
  const ends = new Int32Array(outWidth);
  for (let x = 0; x < outWidth; x++) {
    starts[x] = Math.floor((x * width) / outWidth);
    ends[x] = Math.max(starts[x]! + 1, Math.floor(((x + 1) * width) / outWidth));
  }
  const sums = new Uint32Array(outWidth * 3);
  for (let y = 0; y < outHeight; y++) {
    const top = Math.floor((y * height) / outHeight);
    const bottom = Math.max(top + 1, Math.floor(((y + 1) * height) / outHeight));
    sums.fill(0);
    for (let sy = top; sy < bottom; sy++) {
      const row = sy * width * channels;
      for (let x = 0, at = 0; x < outWidth; x++, at += 3) {
        const to = row + ends[x]! * channels;
        for (let source = row + starts[x]! * channels; source < to; source += channels) {
          sums[at] = sums[at]! + pixels[source]!;
          sums[at + 1] = sums[at + 1]! + pixels[source + 1]!;
          sums[at + 2] = sums[at + 2]! + pixels[source + 2]!;
        }
      }
    }
    for (let x = 0, at = 0; x < outWidth; x++, at += 3) {
      const area = (ends[x]! - starts[x]!) * (bottom - top);
      const target = y * outWidth * 3 + at;
      out[target] = (sums[at]! + (area >> 1)) / area;
      out[target + 1] = (sums[at + 1]! + (area >> 1)) / area;
      out[target + 2] = (sums[at + 2]! + (area >> 1)) / area;
    }
  }
  return { png: await encode(outWidth, outHeight, out), width: outWidth, height: outHeight };
};
