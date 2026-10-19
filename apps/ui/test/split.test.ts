import { describe, expect, it } from "@effect/vitest";

import {
  canSplit,
  closePane,
  closeKeys,
  dropZoneAt,
  focusPane,
  followShown,
  layoutOf,
  leavesOf,
  moveEdge,
  movePane,
  renameKey,
  resizeSplit,
  showInPane,
  singlePane,
  splitPane,
  type PaneNode,
  type Panes,
} from "../src/features/split/model.ts";

const shape = (node: PaneNode): unknown =>
  node.kind === "pane"
    ? node.key
    : { [node.axis]: node.children.map(shape), sizes: node.sizes.map((size) => Math.round(size * 100)) };

/** A file's tab key. */
const file = "file:/r\nx.ts";

/** Thread `a` alone, then `b` to its right. */
const twoAcross = (): Panes => splitPane(singlePane("1", "a"), "1", "right", "b", "2");

describe("splitPane", () => {
  it("opens a pane beside another and focuses it", () => {
    const panes = twoAcross();
    expect(shape(panes.root)).toEqual({ row: ["a", "b"], sizes: [50, 50] });
    expect(panes.focused).toBe("2");
    expect(panes.shown).toBe("b");
  });

  it("shares the parent's space along the same axis", () => {
    const panes = splitPane(twoAcross(), "2", "right", "c", "3");
    expect(shape(panes.root)).toEqual({ row: ["a", "b", "c"], sizes: [50, 25, 25] });
  });

  it("nests a split across the other axis", () => {
    const panes = splitPane(twoAcross(), "1", "bottom", "c", "3");
    expect(shape(panes.root)).toEqual({
      row: [{ column: ["a", "c"], sizes: [50, 50] }, "b"],
      sizes: [50, 50],
    });
  });

  it("opens before the pane on the left or the top", () => {
    const panes = splitPane(singlePane("1", "a"), "1", "top", "b", "2");
    expect(shape(panes.root)).toEqual({ column: ["b", "a"], sizes: [50, 50] });
  });

  it("moves a thread that already shows rather than showing it twice", () => {
    const three = splitPane(twoAcross(), "2", "right", "c", "3");
    const panes = splitPane(three, "1", "bottom", "c", "4");
    expect(shape(panes.root)).toEqual({
      row: [{ column: ["a", "c"], sizes: [50, 50] }, "b"],
      sizes: [50, 50],
    });
  });

  it("opens a file beside a thread as it does any tab", () => {
    const panes = splitPane(singlePane("1", "a"), "1", "right", file, "2");
    expect(shape(panes.root)).toEqual({ row: ["a", file], sizes: [50, 50] });
    expect(panes.focused).toBe("2");
    expect(panes.shown).toBe(file);
  });
});

describe("closePane", () => {
  it("gives its space to its neighbour and its focus too", () => {
    const three = splitPane(twoAcross(), "2", "right", "c", "3");
    const panes = closePane(three, "2")!;
    expect(shape(panes.root)).toEqual({ row: ["a", "c"], sizes: [75, 25] });
    expect(panes.focused).toBe("3");
    const after = closePane(three, "3")!;
    expect(after.focused).toBe("2");
    expect(after.shown).toBe("b");
  });

  it("collapses a split left with one pane", () => {
    const panes = closePane(twoAcross(), "2")!;
    expect(panes.root).toEqual({ kind: "pane", id: "1", key: "a" });
    expect(panes.focused).toBe("1");
    expect(panes.shown).toBe("a");
  });

  it("merges a nested split that's left along its parent's axis", () => {
    // a | (b over c) ; closing b leaves a | c in one row.
    const nested = splitPane(twoAcross(), "2", "bottom", "c", "3");
    const panes = closePane(nested, "2")!;
    expect(shape(panes.root)).toEqual({ row: ["a", "c"], sizes: [50, 50] });
  });

  it("leaves nothing once the last pane closes", () => {
    expect(closePane(singlePane("1", "a"), "1")).toBeUndefined();
  });
});

describe("followShown", () => {
  it("shows the window's new thread in the focused pane", () => {
    const panes = followShown(twoAcross(), "c");
    expect(shape(panes.root)).toEqual({ row: ["a", "c"], sizes: [50, 50] });
    expect(panes.shown).toBe("c");
  });

  it("focuses the pane already showing it", () => {
    const panes = followShown(twoAcross(), "a");
    expect(panes.focused).toBe("1");
    expect(shape(panes.root)).toEqual({ row: ["a", "b"], sizes: [50, 50] });
  });

  it("stays put while the window shows the tab they last followed", () => {
    const withFile = splitPane(twoAcross(), "2", "right", file, "3");
    expect(followShown(withFile, file)).toBe(withFile);
    const replaced = followShown(withFile, "c");
    expect(shape(replaced.root)).toEqual({ row: ["a", "b", "c"], sizes: [50, 25, 25] });
  });
});

describe("focusPane and showInPane", () => {
  it("makes a focused thread pane's thread the one shown", () => {
    const panes = focusPane(twoAcross(), "1");
    expect(panes.focused).toBe("1");
    expect(panes.shown).toBe("a");
  });

  it("focuses the pane that already shows a thread rather than showing it twice", () => {
    const panes = showInPane(twoAcross(), "2", "a");
    expect(panes.focused).toBe("1");
    expect(shape(panes.root)).toEqual({ row: ["a", "b"], sizes: [50, 50] });
  });
});

describe("movePane", () => {
  it("moves a pane to another's side", () => {
    const three = splitPane(twoAcross(), "2", "right", "c", "3");
    const panes = movePane(three, "1", "3", "bottom");
    expect(shape(panes.root)).toEqual({
      row: ["b", { column: ["c", "a"], sizes: [50, 50] }],
      sizes: [75, 25],
    });
    expect(panes.focused).toBe("1");
  });

  it("swaps two panes dropped on the middle", () => {
    const panes = movePane(twoAcross(), "1", "2", "center");
    expect(shape(panes.root)).toEqual({ row: ["b", "a"], sizes: [50, 50] });
    expect(panes.focused).toBe("2");
    expect(panes.shown).toBe("a");
  });
});

describe("threads closing and starting", () => {
  it("closes the panes of closed threads", () => {
    const three = splitPane(twoAcross(), "2", "right", "c", "3");
    expect(shape(closeKeys(three, ["a", "c"])!.root)).toBe("b");
    expect(closeKeys(singlePane("1", "a"), ["a"])).toBeUndefined();
  });

  it("follows a draft to the thread it started", () => {
    const panes = renameKey(twoAcross(), "b", "t");
    expect(shape(panes.root)).toEqual({ row: ["a", "t"], sizes: [50, 50] });
    expect(panes.shown).toBe("t");
  });
});

describe("sizes", () => {
  it("resizes a split by its path", () => {
    const nested = splitPane(twoAcross(), "1", "bottom", "c", "3");
    const panes = resizeSplit(nested, [0], [0.3, 0.7]);
    expect(shape(panes.root)).toEqual({
      row: [{ column: ["a", "c"], sizes: [30, 70] }, "b"],
      sizes: [50, 50],
    });
  });

  it("moves an edge, keeping both sides above the minimum", () => {
    expect(moveEdge([0.5, 0.5], 0, 0.2, 0.1)).toEqual([0.7, 0.30000000000000004]);
    expect(moveEdge([0.5, 0.25, 0.25], 1, 0.5, 0.1).map((size) => Math.round(size * 100))).toEqual([
      50, 40, 10,
    ]);
  });

  it("places panes and the edges between them", () => {
    const nested = splitPane(twoAcross(), "1", "bottom", "c", "3");
    const { panes, edges } = layoutOf(nested.root);
    expect(panes.map(({ leaf, box }) => [leaf.id, box])).toEqual([
      ["1", { x: 0, y: 0, width: 0.5, height: 0.5 }],
      ["3", { x: 0, y: 0.5, width: 0.5, height: 0.5 }],
      ["2", { x: 0.5, y: 0, width: 0.5, height: 1 }],
    ]);
    expect(edges.map(({ path, index, axis, at }) => ({ path, index, axis, at }))).toEqual([
      { path: [0], index: 0, axis: "column", at: 0.5 },
      { path: [], index: 0, axis: "row", at: 0.5 },
    ]);
    expect(leavesOf(nested.root).map((leaf) => leaf.id)).toEqual(["1", "3", "2"]);
  });
});

describe("dropping and room", () => {
  it("lands in the middle, else on the nearest side", () => {
    expect(dropZoneAt(50, 50, 100, 100)).toBe("center");
    expect(dropZoneAt(10, 50, 100, 100)).toBe("left");
    expect(dropZoneAt(90, 40, 100, 100)).toBe("right");
    expect(dropZoneAt(50, 95, 100, 100)).toBe("bottom");
    expect(dropZoneAt(40, 5, 100, 100)).toBe("top");
  });

  it("splits only with room for both halves", () => {
    const min = { width: 300, height: 200 };
    expect(canSplit({ width: 640, height: 300 }, "right", min)).toBe(true);
    expect(canSplit({ width: 640, height: 300 }, "bottom", min)).toBe(false);
  });
});
