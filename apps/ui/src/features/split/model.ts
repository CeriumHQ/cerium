// The main area split into panes, each showing a tab: a thread, a thread not started yet, or a file.
// Panes divide their space as a tree: a split lays its children side by side (a row) or one above the
// other (a column), each taking its share of the split. One pane has focus, and that is the one the
// tabs and the sidebar act on: the window's open tab is the focused pane's. A tab shows in one pane at
// most, so opening one that already shows goes to its pane instead.

export type Axis = "row" | "column";

export interface PaneLeaf {
  readonly kind: "pane";
  readonly id: string;
  /** The tab it shows. */
  readonly key: string;
}

export interface PaneSplit {
  readonly kind: "split";
  readonly axis: Axis;
  readonly children: ReadonlyArray<PaneNode>;
  /** Each child's share of the split, together 1. */
  readonly sizes: ReadonlyArray<number>;
}

export type PaneNode = PaneLeaf | PaneSplit;

export interface Panes {
  readonly root: PaneNode;
  /** The pane the tabs and the sidebar act on. */
  readonly focused: string;
  /**
   * The tab the window showed when the panes last followed it. Once the window shows another (a tab,
   * the sidebar or a notification opened it), the focused pane takes it, or the pane already showing
   * it takes focus.
   */
  readonly shown: string;
}

/** Where beside a pane another one opens. */
export type Side = "left" | "right" | "top" | "bottom";

/** Where a pane dragged over another lands: beside it, or in its place. */
export type DropZone = Side | "center";

/** The one pane showing `key`. */
export const singlePane = (id: string, key: string): Panes => ({
  root: { kind: "pane", id, key },
  focused: id,
  shown: key,
});

/** Every pane, in reading order: left to right, top to bottom. */
export const leavesOf = (node: PaneNode): ReadonlyArray<PaneLeaf> =>
  node.kind === "pane" ? [node] : node.children.flatMap(leavesOf);

export const findPane = (node: PaneNode, id: string) => leavesOf(node).find((leaf) => leaf.id === id);

/** The pane showing the tab `key`. */
export const paneShowing = (node: PaneNode, key: string) => leavesOf(node).find((leaf) => leaf.key === key);

export const isSplit = (panes: Panes) => panes.root.kind === "split";

const axisOf = (side: Side): Axis => (side === "left" || side === "right" ? "row" : "column");
const before = (side: Side) => side === "left" || side === "top";

/** The tab the focused pane shows. */
export const focusedKey = (panes: Panes) => findPane(panes.root, panes.focused)?.key ?? panes.shown;

/** The focused pane's tab becomes the one shown. */
const withShown = (panes: Panes): Panes => ({ ...panes, shown: focusedKey(panes) });

/** `node` with each of its splits that has a child split along its own axis holding that child's children itself. */
const flatten = (node: PaneNode): PaneNode => {
  if (node.kind === "pane") return node;
  const children: Array<PaneNode> = [];
  const sizes: Array<number> = [];
  node.children.forEach((child, index) => {
    const flat = flatten(child);
    const size = node.sizes[index] ?? 0;
    if (flat.kind === "split" && flat.axis === node.axis) {
      flat.children.forEach((grandchild, at) => {
        children.push(grandchild);
        sizes.push(size * (flat.sizes[at] ?? 0));
      });
    } else {
      children.push(flat);
      sizes.push(size);
    }
  });
  return children.length === 1 ? children[0]! : { ...node, children, sizes: normalized(sizes) };
};

const normalized = (sizes: ReadonlyArray<number>) => {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return total > 0 ? sizes.map((size) => size / total) : sizes.map(() => 1 / sizes.length);
};

const insertBeside = (node: PaneNode, target: string, side: Side, leaf: PaneLeaf): PaneNode => {
  const axis = axisOf(side);
  if (node.kind === "pane") {
    if (node.id !== target) return node;
    return {
      kind: "split",
      axis,
      children: before(side) ? [leaf, node] : [node, leaf],
      sizes: [0.5, 0.5],
    };
  }
  const at = node.children.findIndex((child) => child.kind === "pane" && child.id === target);
  // A pane split along its parent's own axis shares the parent's space with the new one.
  if (at !== -1 && node.axis === axis) {
    const half = (node.sizes[at] ?? 0) / 2;
    const index = before(side) ? at : at + 1;
    const children = [...node.children];
    children.splice(index, 0, leaf);
    const sizes = node.sizes.map((size, each) => (each === at ? half : size));
    sizes.splice(index, 0, half);
    return { ...node, children, sizes };
  }
  return { ...node, children: node.children.map((child) => insertBeside(child, target, side, leaf)) };
};

/**
 * `panes` with a new pane `id` showing `key` on `side` of the pane `target`, focused. A tab that
 * already shows elsewhere leaves its pane first, so it still shows once.
 */
export const splitPane = (panes: Panes, target: string, side: Side, key: string, id: string): Panes => {
  const elsewhere = paneShowing(panes.root, key);
  const from =
    elsewhere !== undefined && elsewhere.id !== target ? (closePane(panes, elsewhere.id) ?? panes) : panes;
  const leaf: PaneLeaf = { kind: "pane", id, key };
  return withShown({ ...from, root: flatten(insertBeside(from.root, target, side, leaf)), focused: id });
};

/**
 * `panes` with a pane for each of `added` to the right of the pane `target`, in order, all of them
 * sharing the target's room evenly: threads started together, to read side by side. The focus stays.
 */
export const spreadBeside = (
  panes: Panes,
  target: string,
  added: ReadonlyArray<{ readonly key: string; readonly id: string }>,
): Panes => {
  // A tab shows once: none twice, and none the target already shows.
  const targetKey = findPane(panes.root, target)?.key;
  const adding = added.filter(
    ({ key }, index) => key !== targetKey && added.findIndex((each) => each.key === key) === index,
  );
  const from = adding.reduce((current, { key }) => {
    const elsewhere = paneShowing(current.root, key);
    return elsewhere !== undefined && elsewhere.id !== target
      ? (closePane(current, elsewhere.id) ?? current)
      : current;
  }, panes);
  const leaves: ReadonlyArray<PaneLeaf> = adding.map(({ key, id }) => ({ kind: "pane", id, key }));
  if (leaves.length === 0 || findPane(from.root, target) === undefined) return from;
  const spread = (node: PaneNode): PaneNode => {
    if (node.kind === "pane") {
      if (node.id !== target) return node;
      const children = [node, ...leaves];
      return { kind: "split", axis: "row", children, sizes: children.map(() => 1 / children.length) };
    }
    const at = node.children.findIndex((child) => child.kind === "pane" && child.id === target);
    // A pane already in a row shares its own room there with the new ones.
    if (at !== -1 && node.axis === "row") {
      const share = (node.sizes[at] ?? 0) / (leaves.length + 1);
      return {
        ...node,
        children: [...node.children.slice(0, at + 1), ...leaves, ...node.children.slice(at + 1)],
        sizes: [
          ...node.sizes.slice(0, at),
          ...Array.from({ length: leaves.length + 1 }, () => share),
          ...node.sizes.slice(at + 1),
        ],
      };
    }
    return { ...node, children: node.children.map(spread) };
  };
  return withShown({ ...from, root: flatten(spread(from.root)) });
};

const without = (node: PaneNode, id: string): PaneNode | undefined => {
  if (node.kind === "pane") return node.id === id ? undefined : node;
  const at = node.children.findIndex((child) => leavesOf(child).some((leaf) => leaf.id === id));
  if (at === -1) return node;
  const rest = without(node.children[at]!, id);
  if (rest !== undefined) {
    return { ...node, children: node.children.map((child, index) => (index === at ? rest : child)) };
  }
  // The neighbour before it takes its space, else the one after.
  const heir = at > 0 ? at - 1 : at + 1;
  const sizes = node.sizes.map((size, index) => (index === heir ? size + (node.sizes[at] ?? 0) : size));
  return {
    ...node,
    children: node.children.filter((_, index) => index !== at),
    sizes: sizes.filter((_, index) => index !== at),
  };
};

/**
 * `panes` without the pane `id`: its neighbour takes its space and, when it had focus, the focus.
 * None when it was the only pane.
 */
export const closePane = (panes: Panes, id: string): Panes | undefined => {
  const leaves = leavesOf(panes.root);
  const at = leaves.findIndex((leaf) => leaf.id === id);
  if (at === -1) return panes;
  const root = without(panes.root, id);
  if (root === undefined) return undefined;
  const focused = panes.focused === id ? (leaves[at - 1] ?? leaves[at + 1])!.id : panes.focused;
  return withShown({ ...panes, root: flatten(root), focused });
};

/** `panes` with the pane `id` moved to `side` of `target`, or swapped with it at its center. */
export const movePane = (panes: Panes, id: string, target: string, zone: DropZone): Panes => {
  const moving = findPane(panes.root, id);
  const onto = findPane(panes.root, target);
  if (moving === undefined || onto === undefined || id === target) return panes;
  if (zone === "center") {
    const swap = (node: PaneNode): PaneNode =>
      node.kind === "split"
        ? { ...node, children: node.children.map(swap) }
        : node.id === id
          ? { ...node, key: onto.key }
          : node.id === target
            ? { ...node, key: moving.key }
            : node;
    // The focus goes with what the user moved.
    return withShown({ ...panes, root: swap(panes.root), focused: target });
  }
  const rest = without(panes.root, id);
  if (rest === undefined) return panes;
  return withShown({
    ...panes,
    root: flatten(insertBeside(flatten(rest), target, zone, moving)),
    focused: id,
  });
};

/** `panes` with focus on the pane `id`. */
export const focusPane = (panes: Panes, id: string): Panes =>
  findPane(panes.root, id) === undefined || panes.focused === id
    ? panes
    : withShown({ ...panes, focused: id });

/** `panes` with the pane `id` showing the tab `key` instead. */
export const showInPane = (panes: Panes, id: string, key: string): Panes => {
  const elsewhere = paneShowing(panes.root, key);
  if (elsewhere !== undefined && elsewhere.id !== id) return focusPane(panes, elsewhere.id);
  const replace = (node: PaneNode): PaneNode =>
    node.kind === "split"
      ? { ...node, children: node.children.map(replace) }
      : node.id === id
        ? { ...node, key }
        : node;
  return withShown({ ...panes, root: replace(panes.root) });
};

/**
 * `panes` following the window to the tab `key`: the pane showing it takes focus, else the focused
 * pane shows it. Unchanged while the window still shows the tab they last followed.
 */
export const followShown = (panes: Panes, key: string): Panes => {
  if (key === panes.shown) return panes;
  const showing = paneShowing(panes.root, key);
  if (showing !== undefined) return { ...panes, focused: showing.id, shown: key };
  return { ...showInPane(panes, panes.focused, key), shown: key };
};

/** `panes` without the panes showing any of the tabs `keys`; none when no pane is left. */
export const closeKeys = (panes: Panes, keys: ReadonlyArray<string>): Panes | undefined =>
  leavesOf(panes.root)
    .filter((leaf) => keys.includes(leaf.key))
    .reduce<Panes | undefined>((current, leaf) => current && closePane(current, leaf.id), panes);

/** `panes` with the pane showing the tab `from` showing `to`: a new thread that started. */
export const renameKey = (panes: Panes, from: string, to: string): Panes => {
  const rename = (node: PaneNode): PaneNode =>
    node.kind === "split"
      ? { ...node, children: node.children.map(rename) }
      : node.key === from
        ? { ...node, key: to }
        : node;
  return { ...panes, root: rename(panes.root), shown: panes.shown === from ? to : panes.shown };
};

/** A split, by the child indexes that lead to it from the root. */
export type SplitPath = ReadonlyArray<number>;

/** `panes` with the split at `path` dividing its space by `sizes`. */
export const resizeSplit = (panes: Panes, path: SplitPath, sizes: ReadonlyArray<number>): Panes => {
  const resize = (node: PaneNode, depth: number): PaneNode => {
    if (node.kind === "pane") return node;
    if (depth === path.length) return { ...node, sizes: normalized(sizes) };
    const at = path[depth]!;
    return {
      ...node,
      children: node.children.map((child, index) => (index === at ? resize(child, depth + 1) : child)),
    };
  };
  return { ...panes, root: resize(panes.root, 0) };
};

/**
 * `sizes` with the edge after child `index` moved by `delta` (a share of the split), neither child
 * on it going below `min`.
 */
export const moveEdge = (sizes: ReadonlyArray<number>, index: number, delta: number, min: number) => {
  const a = sizes[index];
  const b = sizes[index + 1];
  if (a === undefined || b === undefined) return sizes;
  const pair = a + b;
  const floor = Math.min(min, pair / 2);
  const next = Math.min(Math.max(a + delta, floor), pair - floor);
  return sizes.map((size, each) => (each === index ? next : each === index + 1 ? pair - next : size));
};

/** A box as shares of the main area. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The edge between two children of a split, to drag. */
export interface Edge {
  readonly path: SplitPath;
  /** The edge is after this child. */
  readonly index: number;
  readonly axis: Axis;
  /** The split's box. */
  readonly box: Box;
  /** Where along the split's axis the edge is, as a share of the main area. */
  readonly at: number;
  readonly sizes: ReadonlyArray<number>;
}

/** Where each pane sits in the main area, and the edges between them. */
export const layoutOf = (
  root: PaneNode,
): {
  readonly panes: ReadonlyArray<{ readonly leaf: PaneLeaf; readonly box: Box }>;
  readonly edges: ReadonlyArray<Edge>;
} => {
  const panes: Array<{ leaf: PaneLeaf; box: Box }> = [];
  const edges: Array<Edge> = [];
  const place = (node: PaneNode, box: Box, path: SplitPath) => {
    if (node.kind === "pane") {
      panes.push({ leaf: node, box });
      return;
    }
    const row = node.axis === "row";
    let offset = 0;
    node.children.forEach((child, index) => {
      const share = node.sizes[index] ?? 0;
      const childBox: Box = row
        ? { x: box.x + offset * box.width, y: box.y, width: share * box.width, height: box.height }
        : { x: box.x, y: box.y + offset * box.height, width: box.width, height: share * box.height };
      place(child, childBox, [...path, index]);
      offset += share;
      if (index < node.children.length - 1) {
        edges.push({
          path,
          index,
          axis: node.axis,
          box,
          at: row ? box.x + offset * box.width : box.y + offset * box.height,
          sizes: node.sizes,
        });
      }
    });
  };
  place(root, { x: 0, y: 0, width: 1, height: 1 }, []);
  return { panes, edges };
};

/**
 * Where a drop at (`x`, `y`) in a pane `width` by `height` lands: in its place in the middle, else
 * beside it on the nearest side.
 */
export const dropZoneAt = (x: number, y: number, width: number, height: number): DropZone => {
  const fx = x / width;
  const fy = y / height;
  if (fx > 0.3 && fx < 0.7 && fy > 0.3 && fy < 0.7) return "center";
  const distances: ReadonlyArray<readonly [Side, number]> = [
    ["left", fx],
    ["right", 1 - fx],
    ["top", fy],
    ["bottom", 1 - fy],
  ];
  return distances.reduce((best, each) => (each[1] < best[1] ? each : best))[0];
};

/**
 * Whether a pane `width` by `height` (in pixels) has room to split on `side`, each half keeping
 * `min` of room.
 */
export const canSplit = (
  size: { readonly width: number; readonly height: number },
  side: Side,
  min: { readonly width: number; readonly height: number },
) => (axisOf(side) === "row" ? size.width >= min.width * 2 : size.height >= min.height * 2);
