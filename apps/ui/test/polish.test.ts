import { describe, expect, it } from "@effect/vitest";

import {
  FOG_HALF_LIFE_MS,
  FOG_HOLD_MS,
  FOG_ONSET_MS,
  PolishGrid,
  breath,
  fogFactor,
  isEmpty,
  revealLength,
  revealStrokes,
  seeded,
  union,
  type RevealLine,
} from "../src/app/polish.ts";

describe("fogFactor", () => {
  it("keeps a wipe clear while it holds", () => {
    expect(fogFactor(FOG_HOLD_MS, 16)).toBe(1);
    expect(fogFactor(10_000, 0)).toBe(1);
  });

  it("takes back half every half-life at full force", () => {
    expect(fogFactor(FOG_HOLD_MS + FOG_ONSET_MS, FOG_HALF_LIFE_MS)).toBeCloseTo(0.5);
    expect(fogFactor(60_000, FOG_HALF_LIFE_MS * 2)).toBeCloseTo(0.25);
  });

  it("comes on gradually after the hold", () => {
    expect(fogFactor(FOG_HOLD_MS + FOG_ONSET_MS / 2, FOG_HALF_LIFE_MS)).toBeCloseTo(0.5 ** 0.5);
  });
});

describe("cell bounds", () => {
  const empty = { left: 0, top: 0, right: 0, bottom: 0 };
  const some = { left: 1, top: 2, right: 3, bottom: 4 };

  it("unions around an empty side", () => {
    expect(isEmpty(empty)).toBe(true);
    expect(union(empty, some)).toBe(some);
    expect(union(some, empty)).toBe(some);
    expect(union(some, { left: 0, top: 3, right: 5, bottom: 4 })).toEqual({
      left: 0,
      top: 2,
      right: 5,
      bottom: 4,
    });
  });
});

describe("PolishGrid", () => {
  it("covers the glass in whole cells, at least one", () => {
    const grid = new PolishGrid(10, 9, 4);
    expect([grid.cols, grid.rows]).toEqual([3, 3]);
    const none = new PolishGrid(0, 0);
    expect([none.cols, none.rows]).toEqual([1, 1]);
  });

  it("starts frosted, and is frosted outside", () => {
    const grid = new PolishGrid(40, 40, 4);
    expect(grid.clear).toBe(false);
    expect(grid.at(3, 3)).toBe(0);
    expect(grid.at(-1, 0)).toBe(0);
    expect(grid.at(0, 10)).toBe(0);
  });

  it("clears most under the middle of a dab and none at its radius", () => {
    const grid = new PolishGrid(40, 40, 4);
    grid.dab(18, 18, 8, 0.5);
    expect(grid.at(4, 4)).toBeCloseTo(0.5);
    expect(grid.at(5, 4)).toBeCloseTo(0.5 * 0.75 ** 2);
    expect(grid.at(6, 4)).toBe(0);
    expect(grid.bounds).toEqual({ left: 2, top: 2, right: 7, bottom: 7 });
  });

  it("builds dabs up without passing clear", () => {
    const grid = new PolishGrid(40, 40, 4);
    grid.dab(18, 18, 8, 0.5);
    grid.dab(18, 18, 8, 0.5);
    expect(grid.at(4, 4)).toBeCloseTo(0.75);
    for (let dab = 0; dab < 50; dab++) grid.dab(18, 18, 8, 1);
    expect(grid.at(4, 4)).toBe(1);
  });

  it("ignores a dab off the glass", () => {
    const grid = new PolishGrid(40, 40, 4);
    grid.dab(-100, -100, 8, 1);
    grid.dab(18, 18, 0, 1);
    expect(grid.clear).toBe(false);
  });

  it("touches down along a rub, past where it started", () => {
    const grid = new PolishGrid(40, 8, 4);
    grid.rub({ x: 2, y: 2 }, { x: 38, y: 2 }, 4, 0.3, 4);
    expect(grid.at(0, 0)).toBe(0);
    for (let col = 1; col < 10; col++) expect(grid.at(col, 0)).toBeCloseTo(0.3);
  });

  it("lets the fog back, down to frosted", () => {
    const grid = new PolishGrid(40, 40, 4);
    grid.dab(18, 18, 8, 0.8);
    grid.fog(1);
    expect(grid.at(4, 4)).toBeCloseTo(0.8);
    grid.fog(0.5);
    expect(grid.at(4, 4)).toBeCloseTo(0.4);
    expect(grid.clear).toBe(true);
    grid.fog(0.001);
    expect(grid.at(4, 4)).toBe(0);
    expect(grid.clear).toBe(false);
    expect(isEmpty(grid.bounds)).toBe(true);
  });

  it("knows its clearest cell as the fog comes back", () => {
    const grid = new PolishGrid(40, 40, 4);
    expect(grid.peak).toBe(0);
    grid.dab(10, 10, 2, 0.3);
    grid.dab(30, 30, 2, 0.8);
    expect(grid.peak).toBeCloseTo(0.8);
    grid.fog(0.5);
    expect(grid.peak).toBeCloseTo(0.4);
    grid.fog(0.001);
    expect(grid.peak).toBe(0);
  });

  it("shrinks its bounds as the edges fog over", () => {
    const grid = new PolishGrid(40, 40, 4);
    grid.dab(18, 18, 8, 0.05);
    grid.fog(0.5);
    expect(grid.bounds).toEqual({ left: 3, top: 3, right: 6, bottom: 6 });
  });

  it("absorbs whatever a grid of its size has clearer", () => {
    const rubbed = new PolishGrid(40, 40, 4);
    const typed = new PolishGrid(40, 40, 4);
    rubbed.dab(18, 18, 2, 0.2);
    rubbed.dab(30, 30, 2, 0.9);
    typed.dab(18, 18, 2, 0.6);
    typed.dab(30, 30, 2, 0.1);
    rubbed.absorb(typed);
    expect(rubbed.at(4, 4)).toBeCloseTo(0.6);
    expect(rubbed.at(7, 7)).toBeCloseTo(0.9);

    const other = new PolishGrid(80, 40, 4);
    other.dab(2, 2, 2, 1);
    rubbed.absorb(other);
    expect(rubbed.at(0, 0)).toBe(0);
  });

  it("frosts over again on reset", () => {
    const grid = new PolishGrid(40, 40, 4);
    grid.dab(18, 18, 8, 1);
    grid.reset();
    expect(grid.clear).toBe(false);
    expect(grid.values.every((value) => value === 0)).toBe(true);
  });
});

describe("seeded", () => {
  it("runs the same from the same seed, in [0, 1)", () => {
    const run = (seed: number) => Array.from({ length: 50 }, seeded(seed));
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
    expect(run(7).every((value) => value >= 0 && value < 1)).toBe(true);
  });
});

describe("breath", () => {
  const question = { left: 100, top: 100, right: 300, bottom: 160 };
  const fogOver = (seed: number) => {
    const grid = new PolishGrid(400, 300, 4);
    return { grid, fog: breath(grid, 400, 300, question, 40, seeded(seed)) };
  };

  it("fogs the question over, in full across its middle", () => {
    const { grid, fog } = fogOver(1);
    const at = (x: number, y: number) =>
      fog[Math.floor(y / grid.cell) * grid.cols + Math.floor(x / grid.cell)] ?? 0;
    for (const x of [101, 200, 299]) expect(at(x, 130)).toBeGreaterThan(0.95);
    for (const [x, y] of [
      [101, 101],
      [299, 159],
    ] as const) {
      expect(at(x, y)).toBeGreaterThan(0.5);
    }
  });

  it("thins out to clear glass at the pane's edges", () => {
    const { grid, fog } = fogOver(1);
    const edges: Array<number> = [];
    for (let col = 0; col < grid.cols; col++) {
      edges.push(fog[col] ?? 1, fog[(grid.rows - 1) * grid.cols + col] ?? 1);
    }
    for (let row = 0; row < grid.rows; row++) {
      edges.push(fog[row * grid.cols] ?? 1, fog[row * grid.cols + grid.cols - 1] ?? 1);
    }
    expect(Math.max(...edges)).toBeLessThan(0.01);
  });

  it("lies between clear and full, shaped the same by the same seed", () => {
    const { fog } = fogOver(3);
    expect(fog.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(fogOver(3).fog).toEqual(fog);
  });
});

describe("revealStrokes", () => {
  const lines: ReadonlyArray<RevealLine> = [
    { left: 10, middle: 50, ends: [10, 20, 30] },
    { left: 12, middle: 100, ends: [8, 16] },
  ];

  it("wipes the n-th character for the n-th typed, reaching past a line's ends", () => {
    expect(revealStrokes(lines, 0, 1, 5)).toEqual([{ from: 5, to: 20, y: 50 }]);
    expect(revealStrokes(lines, 0, 3, 5)).toEqual([{ from: 5, to: 45, y: 50 }]);
  });

  it("carries on to the next line", () => {
    expect(revealStrokes(lines, 0, 4, 5)).toEqual([
      { from: 5, to: 45, y: 50 },
      { from: 7, to: 20, y: 100 },
    ]);
  });

  it("wipes part of a character for part of one", () => {
    expect(revealStrokes(lines, 1.5, 2, 5)).toEqual([{ from: 25, to: 30, y: 50 }]);
  });

  it("wipes nothing past the question's end", () => {
    expect(revealStrokes(lines, 5, 9, 5)).toEqual([]);
    expect(revealLength(lines)).toBe(5);
  });
});
