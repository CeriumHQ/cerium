// @vitest-environment happy-dom

import type { DiffHunk } from "@cerium/rpc";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { act, createElement as element } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vite-plus/test";

import { commentRuns, DiffView, hunkTarget } from "../src/features/viewer/DiffView.tsx";
import { numberHunks } from "../src/features/viewer/model.ts";

const hunk = (oldStart: number, newStart: number, lines: DiffHunk["lines"]): DiffHunk => ({
  oldStart,
  newStart,
  lines,
});

const hunks = [
  hunk(3, 3, [
    { kind: "context", text: "a" },
    { kind: "removed", text: "const x = 1;" },
    { kind: "added", text: "const x = 2;" },
    { kind: "added", text: "const y = 3;" },
    { kind: "context", text: "b" },
  ]),
  hunk(20, 21, [{ kind: "removed", text: "gone" }]),
];

describe("hunk navigator", () => {
  it("goes to the next hunk below the view's top, or the last one above it", () => {
    const offsets = [0, 400, 900];
    expect(hunkTarget(offsets, 12, "next")).toBe(1);
    expect(hunkTarget(offsets, 400, "next")).toBe(2);
    expect(hunkTarget(offsets, 400, "previous")).toBe(0);
    expect(hunkTarget(offsets, 900, "next")).toBeUndefined();
    expect(hunkTarget(offsets, 1, "previous")).toBeUndefined();
    expect(hunkTarget(offsets, 650, "previous")).toBe(1);
  });

  it("counts each run of lines a waiting comment covers once, by the hunk it starts in", () => {
    const numbered = numberHunks(hunks).hunks;
    // New lines 4 and 5 run together; old line 20 is the second hunk's.
    expect(commentRuns(numbered, new Set([4, 5]))).toEqual([0]);
    expect(commentRuns(numbered, new Set([3, 6, 20]))).toEqual([0, 0, 1]);
    expect(commentRuns(numbered, new Set())).toEqual([]);
  });
});

describe("DiffView on a phone", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("max-width") || query.includes("coarse"),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        readonly callback: IntersectionObserverCallback;
        constructor(callback: IntersectionObserverCallback) {
          this.callback = callback;
        }
        observe(target: Element) {
          this.callback(
            [{ isIntersecting: true, target } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
        }
        disconnect() {}
      },
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = async () =>
    act(async () =>
      root.render(
        element(DiffView, {
          hunks,
          path: "src/a.ts",
          layout: "split",
          onExpand: undefined,
          commenting: { marked: new Set([4]), onAdd: () => undefined },
        }),
      ),
    );

  const button = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);

  it("wraps by default, with one gutter and the hunk navigator", async () => {
    await render();
    const wrap = button("Wrap lines");
    expect(wrap?.getAttribute("aria-pressed")).toBe("true");
    expect(button("Previous change")).not.toBeNull();
    expect(button("Next change")).not.toBeNull();
    expect(button("Comments")?.textContent).toBe("1");
    expect(container.querySelector(".whitespace-pre-wrap")).not.toBeNull();
    // Unified on a phone, a row holds the new number alone, and a removed row its old one.
    const rows = [...container.querySelectorAll("[data-run-id]")];
    expect(rows).toHaveLength(6);
    const numbers = rows.map((row) =>
      [...row.querySelectorAll(".tabular-nums")].map((cell) => cell.textContent),
    );
    expect(numbers.slice(0, 3)).toEqual([["3"], ["4"], ["4"]]);

    await act(async () => wrap?.click());
    expect(button("Wrap lines")?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".whitespace-pre-wrap")).toBeNull();
  });
});
