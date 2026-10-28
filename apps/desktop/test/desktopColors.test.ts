import { describe, expect, it } from "@effect/vitest";

import { dominantColor, oklchFromHex } from "../src/desktopColors.ts";

/** A picture of `count` pixels of one sRGB colour, as Chromium lays them out (BGRA). */
const pixels = (count: number, [red, green, blue]: readonly [number, number, number]) =>
  Uint8Array.from({ length: count * 4 }, (_, index) => [blue, green, red, 255][index % 4]!);

describe("oklchFromHex", () => {
  it("reads the system's RGBA hex, with or without a hash", () => {
    const blue = oklchFromHex("0078d4ff");
    expect(blue?.l).toBeCloseTo(0.57, 2);
    expect(blue?.c).toBeCloseTo(0.17, 2);
    expect(blue?.h).toBeCloseTo(251.3, 1);
    expect(oklchFromHex("#0078d4")).toEqual(blue);
  });

  it("gives white no chroma", () => {
    expect(oklchFromHex("ffffff")?.l).toBeCloseTo(1, 3);
    expect(oklchFromHex("ffffff")?.c).toBeCloseTo(0, 3);
  });

  it("refuses what isn't a colour", () => {
    expect(oklchFromHex("")).toBeUndefined();
    expect(oklchFromHex("blue")).toBeUndefined();
  });
});

describe("dominantColor", () => {
  it("takes the hue of a picture's colour, not of its greys", () => {
    const picture = new Uint8Array([...pixels(90, [128, 128, 128]), ...pixels(10, [200, 30, 30])]);
    const color = dominantColor(picture)!;
    const red = oklchFromHex("c81e1e")!;
    expect(color.h).toBeCloseTo(red.h, 0);
    // A tenth of the picture is red, so it is a tenth as colourful.
    expect(color.c).toBeCloseTo(red.c / 10, 3);
  });

  it("follows the larger of two colours", () => {
    const picture = new Uint8Array([...pixels(30, [30, 160, 60]), ...pixels(70, [40, 80, 220])]);
    expect(dominantColor(picture)!.h).toBeCloseTo(oklchFromHex("2850dc")!.h, 0);
  });

  it("skips transparent pixels, and has nothing to say about a wholly transparent picture", () => {
    const clear = new Uint8Array(400);
    expect(dominantColor(clear)).toBeUndefined();
    expect(dominantColor(new Uint8Array([...clear, ...pixels(1, [200, 30, 30])]))!.c).toBeCloseTo(
      oklchFromHex("c81e1e")!.c,
      3,
    );
  });
});
