import { describe, expect, it } from "@effect/vitest";

import { isThreadId, onScreen, parseSavedWindows } from "../src/threadWindows.ts";

describe("parseSavedWindows", () => {
  it("reads the windows a file remembers", () => {
    const text = JSON.stringify([
      {
        threadId: "thr_01",
        mode: "work",
        bounds: { x: 1920, y: 0, width: 960, height: 780 },
        maximized: true,
      },
      { threadId: "thr_02", mode: "chat" },
    ]);
    expect(parseSavedWindows(text)).toEqual([
      {
        threadId: "thr_01",
        mode: "work",
        bounds: { x: 1920, y: 0, width: 960, height: 780 },
        maximized: true,
      },
      { threadId: "thr_02", mode: "chat" },
    ]);
  });

  it("leaves out what doesn't read as a window, and keeps the rest", () => {
    const text = JSON.stringify([
      { threadId: "../etc", mode: "work" },
      { threadId: "thr_01", mode: "plan" },
      { threadId: "thr_02", mode: "work", bounds: { x: "left" } },
      null,
    ]);
    expect(parseSavedWindows(text)).toEqual([{ threadId: "thr_02", mode: "work" }]);
  });

  it("reads nothing from a missing or broken file", () => {
    expect(parseSavedWindows(undefined)).toEqual([]);
    expect(parseSavedWindows("{")).toEqual([]);
    expect(parseSavedWindows('{"threadId":"thr_01"}')).toEqual([]);
  });
});

describe("isThreadId", () => {
  it("takes a backend id and refuses anything else", () => {
    expect(isThreadId("thr_01a177d4-8b76-73b4-924b-e5b61ffe8d02")).toBe(true);
    expect(isThreadId("thr 01")).toBe(false);
    expect(isThreadId("")).toBe(false);
    expect(isThreadId(42)).toBe(false);
  });
});

describe("onScreen", () => {
  const screens = [
    { x: 0, y: 0, width: 1920, height: 1040 },
    { x: 1920, y: 0, width: 1920, height: 1040 },
  ];

  it("keeps a window on either screen", () => {
    expect(onScreen({ x: 2100, y: 100, width: 960, height: 780 }, screens)).toBe(true);
    expect(onScreen({ x: 200, y: 100, width: 960, height: 780 }, screens)).toBe(true);
  });

  it("drops a window left on a screen that's gone", () => {
    expect(onScreen({ x: 2100, y: 100, width: 960, height: 780 }, screens.slice(0, 1))).toBe(false);
  });

  it("drops a window with too little left on screen to grab", () => {
    expect(onScreen({ x: -930, y: 100, width: 960, height: 780 }, screens.slice(0, 1))).toBe(false);
  });
});
