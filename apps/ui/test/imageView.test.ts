import { describe, expect, it } from "@effect/vitest";

import {
  clampView,
  doubleTapScaleFor,
  FIT,
  maxScaleFor,
  resist,
  swipeCloses,
  swipeStep,
  zoomAt,
} from "../src/components/imageView.ts";
import type { TranscriptBlock } from "../src/features/transcript/model.ts";
import { threadImages } from "../src/features/transcript/tools.ts";

const stage = { width: 400, height: 800 };
const fitted = { width: 400, height: 225 };

describe("maxScaleFor", () => {
  it("lets a 4K screenshot on a phone zoom to its own pixels", () => {
    expect(maxScaleFor({ width: 3840, height: 2160 }, fitted)).toBe(9.6);
  });

  it("lets a small image zoom four times at least", () => {
    expect(maxScaleFor({ width: 200, height: 100 }, { width: 200, height: 100 })).toBe(4);
  });

  it("stays put before the image has a size", () => {
    expect(maxScaleFor({ width: 0, height: 0 }, { width: 0, height: 0 })).toBe(1);
  });
});

describe("doubleTapScaleFor", () => {
  it("zooms three times, or as far as the image goes", () => {
    expect(doubleTapScaleFor(9.6)).toBe(3);
    expect(doubleTapScaleFor(2)).toBe(2);
  });
});

describe("clampView", () => {
  it("never shrinks the image below fitting", () => {
    expect(clampView({ scale: 0.5, x: 30, y: 30 }, fitted, stage, 4)).toEqual(FIT);
  });

  it("keeps an enlarged image's edges at the stage's", () => {
    // 1200 × 675 on a 400 × 800 stage: 400 to spare sideways, none up and down.
    expect(clampView({ scale: 3, x: 900, y: 50 }, fitted, stage, 4)).toEqual({ scale: 3, x: 400, y: 0 });
    expect(clampView({ scale: 3, x: -900, y: 0 }, fitted, stage, 4)).toEqual({ scale: 3, x: -400, y: 0 });
  });

  it("caps the scale", () => {
    expect(clampView({ scale: 12, x: 0, y: 0 }, fitted, stage, 4).scale).toBe(4);
  });
});

describe("zoomAt", () => {
  it("keeps the point zoomed on under the pointer", () => {
    const at = { x: 100, y: -40 };
    const zoomed = zoomAt(FIT, 2, at);
    // The image's point under `at` before: (at - offset) / scale; after, it lands on `at` again.
    expect((at.x - zoomed.x) / zoomed.scale).toBe(at.x);
    expect((at.y - zoomed.y) / zoomed.scale).toBe(at.y);
  });

  it("zooms about the centre without moving it", () => {
    expect(zoomAt({ scale: 2, x: 10, y: 0 }, 4, { x: 0, y: 0 })).toEqual({ scale: 4, x: 20, y: 0 });
  });
});

describe("swipeStep", () => {
  it("moves on past a fifth of the width", () => {
    expect(swipeStep(-100, 0, 400)).toBe(1);
    expect(swipeStep(100, 0, 400)).toBe(-1);
  });

  it("moves on for a flick", () => {
    expect(swipeStep(-40, -0.8, 400)).toBe(1);
  });

  it("stays for a short, slow drag or a flick back", () => {
    expect(swipeStep(-40, -0.1, 400)).toBe(0);
    expect(swipeStep(-40, 0.8, 400)).toBe(0);
  });
});

describe("swipeCloses", () => {
  it("closes a third of the way down or on a flick", () => {
    expect(swipeCloses(300, 0, 800)).toBe(true);
    expect(swipeCloses(60, 0.9, 800)).toBe(true);
    expect(swipeCloses(60, 0.1, 800)).toBe(false);
  });
});

describe("resist", () => {
  it("gives way less the further it goes", () => {
    expect(resist(0)).toBe(0);
    expect(resist(120)).toBe(60);
    expect(resist(-120)).toBe(-60);
    expect(resist(600)).toBeLessThan(120);
  });
});

describe("threadImages", () => {
  const user = (id: string, ...names: Array<string>): TranscriptBlock => ({
    kind: "user",
    id,
    text: "",
    mentions: [],
    attachments: names.map((name) => ({
      name,
      path: `C:/attachments/${name}`,
      mediaType: name.endsWith(".png") ? "image/png" : "text/plain",
    })) as never,
  });
  const read = (id: string, path: string): TranscriptBlock => ({
    kind: "tool",
    id,
    toolName: "Read",
    input: { file_path: path },
    status: "done",
    changedFiles: [],
  });

  it("lists the user's images and the ones tools read, in reading order", () => {
    const images = threadImages([
      user("u1", "one.png", "notes.txt"),
      read("t1", "C:/repo/shot.png"),
      { kind: "replaced", id: "r", blocks: [user("u2", "old.png")] },
      user("u3", "two.png"),
    ]);
    expect(images.map((image) => image.name)).toEqual(["one.png", "shot.png", "old.png", "two.png"]);
    expect(new Set(images.map((image) => image.key)).size).toBe(4);
  });
});
