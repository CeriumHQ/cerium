import { describe, expect, it } from "@effect/vitest";

import {
  imageEncodings,
  imageLimits,
  isPreviewable,
  mediaTypeOf,
} from "../src/features/composer/attachments.ts";

describe("mediaTypeOf", () => {
  it("knows phones' HEIC and HEIF photos by their extension", () => {
    expect(mediaTypeOf(new File([], "IMG_0001.HEIC"))).toBe("image/heic");
    expect(mediaTypeOf(new File([], "photo.heif"))).toBe("image/heif");
    expect(isPreviewable(new File([], "IMG_0001.heic"))).toBe(false);
  });
});

describe("imageLimits", () => {
  it("sends smaller images from the web client", () => {
    expect(imageLimits(true)).toEqual({ maxSide: 1600, maxBytes: 1.8 * 1024 * 1024 });
    expect(imageLimits(false)).toEqual({ maxSide: 2000, maxBytes: 3.5 * 1024 * 1024 });
  });
});

describe("imageEncodings", () => {
  it("sends photos as JPEG, and tries PNG first for the rest", () => {
    expect(imageEncodings("image/heic").map((each) => each.type)).toEqual(["image/jpeg", "image/jpeg"]);
    expect(imageEncodings("image/jpeg")[0]).toEqual({ type: "image/jpeg", quality: 0.88 });
    expect(imageEncodings("image/png").map((each) => each.type)).toEqual([
      "image/png",
      "image/jpeg",
      "image/jpeg",
    ]);
  });
});
