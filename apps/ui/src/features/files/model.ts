import type { AgentEvent } from "@cerium/protocol";
import type { FileChange, FileEntry, FileListing, FileState, FileStatuses } from "@cerium/rpc";

import { relativePath, resolvePath } from "../transcript/paths.ts";

// What the file explorer shows of a thread's folder: its rows, what git and the thread's agents did to
// them, and the keys that move around them. Plain functions; the panel feeds them what the backend says.

/** The `RPC_VERSION` that brought the explorer's calls; an older machine can't be browsed. */
export const FILES_VERSION = 3;

/**
 * Opens a file of the folder in a tab of its own, showing its changes against the last commit
 * (`changes`). Where the viewer can't, in the file's own app.
 */
export type OpenFile = (path: string, options?: { readonly changes?: boolean }) => void;

/**
 * A modified click: Ctrl, the middle button or a double click. A folder ignores it, so only a plain
 * click opens or closes one.
 */
export const wantsTab = (event: { ctrlKey: boolean; metaKey: boolean; button: number; detail: number }) =>
  event.ctrlKey || event.metaKey || event.button === 1 || event.detail >= 2;

// ---------------------------------------------------------------------------------------------
// Git

/** What is under a folder that differs from the last commit, in the one state that stands for it. */
export interface Rollup {
  readonly state: FileState;
  /** How many changed files; new folders count once. */
  readonly count: number;
}

/** What git says about the folder, ready to look paths up in. */
export interface ChangeIndex {
  /** Not in git: nothing is said about anything. */
  readonly repository: boolean;
  readonly files: ReadonlyMap<string, FileChange>;
  /** Folders git hasn't seen at all, so everything in them is new. */
  readonly newFolders: ReadonlySet<string>;
  readonly rollups: ReadonlyMap<string, Rollup>;
  /** For each folder, the entries deleted from it: names, and whether the entry was a folder. */
  readonly gone: ReadonlyMap<string, ReadonlyMap<string, boolean>>;
  readonly truncated: boolean;
}

export const noChanges: ChangeIndex = {
  repository: false,
  files: new Map(),
  newFolders: new Set(),
  rollups: new Map(),
  gone: new Map(),
  truncated: false,
};

/** Which state a folder takes when its changed files differ: the one that needs the most attention. */
const urgency: Readonly<Record<FileState, number>> = {
  conflicted: 0,
  modified: 1,
  renamed: 1,
  deleted: 2,
  added: 3,
  untracked: 4,
};

/** The folders above a path, outermost first: `a/b/c` is under `a` and `a/b`. */
export const ancestors = (path: string): ReadonlyArray<string> => {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
};

export const joinPath = (folder: string, name: string) => (folder === "" ? name : `${folder}/${name}`);

export const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
export const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export const indexChanges = (statuses: FileStatuses | undefined): ChangeIndex => {
  if (statuses === undefined || !statuses.repository) return noChanges;
  const files = new Map<string, FileChange>();
  const newFolders = new Set<string>();
  const rollups = new Map<string, Rollup>();
  const gone = new Map<string, Map<string, boolean>>();
  for (const change of statuses.changes) {
    const folder = change.path.endsWith("/");
    const path = folder ? change.path.slice(0, -1) : change.path;
    if (folder) newFolders.add(path);
    else files.set(path, change);
    for (const above of ancestors(path)) {
      const before = rollups.get(above);
      rollups.set(above, {
        state:
          before === undefined || urgency[change.state] < urgency[before.state] ? change.state : before.state,
        count: (before?.count ?? 0) + 1,
      });
    }
    if (change.state === "deleted") {
      const parts = path.split("/");
      parts.forEach((name, index) => {
        const parent = parts.slice(0, index).join("/");
        const siblings = gone.get(parent) ?? new Map<string, boolean>();
        siblings.set(name, siblings.get(name) === true || index < parts.length - 1);
        gone.set(parent, siblings);
      });
    }
  }
  return { repository: true, files, newFolders, rollups, gone, truncated: statuses.truncated === true };
};

/** A path's own state: its own change, or being inside (or being) a folder git has never seen. */
export const stateAt = (changes: ChangeIndex, path: string): FileState | undefined => {
  const own = changes.files.get(path)?.state;
  if (own !== undefined) return own;
  if (changes.newFolders.has(path)) return "untracked";
  return ancestors(path).some((above) => changes.newFolders.has(above)) ? "untracked" : undefined;
};

/** The letter that stands for a state beside a file, as editors show it. */
export const stateLetter: Readonly<Record<FileState, string>> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "!",
};

export const stateWord: Readonly<Record<FileState, string>> = {
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "New",
  conflicted: "Conflict",
};

// ---------------------------------------------------------------------------------------------
// What the thread's agents touched

/** Files the thread's agents changed, by where the folder's own files are named. */
export interface Touched {
  /** Windows paths ignore case, so what's looked up is lowered; elsewhere it is as written. */
  readonly insensitive: boolean;
  /** By lookup key: the file as the agents named it inside the folder, what was last done, and how often. */
  readonly files: ReadonlyMap<
    string,
    { readonly path: string; readonly change: "created" | "modified" | "deleted"; readonly count: number }
  >;
  /** The folders above them, which stand for what is inside. */
  readonly folders: ReadonlySet<string>;
}

const isWindowsPath = (path: string) => /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");

export const touchedKey = (touched: Touched, path: string) =>
  touched.insensitive ? path.toLowerCase() : path;

/** The files `FileChanged` events name inside `root`, the last change to each winning. */
export const touchedFiles = (events: ReadonlyArray<AgentEvent>, root: string): Touched => {
  const insensitive = isWindowsPath(root);
  const files = new Map<
    string,
    { path: string; change: "created" | "modified" | "deleted"; count: number }
  >();
  const folders = new Set<string>();
  const key = (path: string) => (insensitive ? path.toLowerCase() : path);
  for (const event of events) {
    if (event.payload._tag !== "FileChanged") continue;
    const location = resolvePath(event.payload.path, root);
    const path = location === undefined ? undefined : relativePath(location, root);
    if (path === undefined) continue;
    const before = files.get(key(path));
    // A file made and then edited is still one the agents made.
    const change =
      event.payload.change === "modified" && before?.change === "created" ? "created" : event.payload.change;
    files.set(key(path), { path, change, count: (before?.count ?? 0) + 1 });
    for (const above of ancestors(path)) folders.add(key(above));
  }
  return { insensitive, files, folders };
};

export const noTouched: Touched = { insensitive: false, files: new Map(), folders: new Set() };

/** How a file the agents touched is told apart on its row, for the tooltip. */
export const touchWord = (change: "created" | "modified" | "deleted") =>
  change === "created"
    ? "Created by an agent"
    : change === "deleted"
      ? "Deleted by an agent"
      : "Changed by an agent";

// ---------------------------------------------------------------------------------------------
// Rows

/** What a folder's listing is: read, or still on its way. */
export type Listed = FileListing | "loading" | "failed";

/** One line of the tree. */
export interface Row {
  /** Relative to the thread's folder. */
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  readonly folder: boolean;
  readonly expanded: boolean;
  /** Open, and its entries haven't arrived. */
  readonly loading: boolean;
  /** Git ignores it. */
  readonly ignored: boolean;
  /** Dependencies, build output or caches: closed until asked. */
  readonly heavy: boolean;
  readonly link: boolean;
  /** Deleted: only git remembers it. */
  readonly gone: boolean;
  readonly state?: FileState;
  /** For a folder: what changed inside it. */
  readonly rollup?: Rollup;
}

/** Folders first, then each group by name with numbers in order, as the backend lists them. */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export const compareNames = (a: { name: string; folder: boolean }, b: { name: string; folder: boolean }) =>
  Number(b.folder) - Number(a.folder) || collator.compare(a.name, b.name) || (a.name < b.name ? -1 : 1);

/** An entry of a folder as the tree lists it: on disk, or deleted and remembered only by git. */
type Item = FileEntry & { readonly gone?: boolean };

/** A folder's entries with what git remembers of deleted ones between them. */
const withGone = (
  entries: ReadonlyArray<FileEntry>,
  gone: ReadonlyMap<string, boolean> | undefined,
): ReadonlyArray<Item> => {
  if (gone === undefined || gone.size === 0) return entries;
  const present = new Set(entries.map((entry) => entry.name));
  const missing: Array<Item> = [...gone]
    .filter(([name]) => !present.has(name))
    .map(([name, folder]) => ({ name, folder, gone: true }));
  return missing.length === 0 ? entries : [...entries, ...missing].toSorted(compareNames);
};

/**
 * The tree's rows, top to bottom: each folder that is open lists its entries beneath it. `listing`
 * says what each folder holds; a folder not read yet shows as loading.
 */
export const buildRows = (input: {
  readonly expanded: ReadonlySet<string>;
  readonly listing: (dir: string) => Listed;
  readonly changes: ChangeIndex;
}): ReadonlyArray<Row> => {
  const rows: Array<Row> = [];
  const visit = (dir: string, depth: number, deleted: boolean) => {
    const listed: Listed = deleted ? { entries: [] } : input.listing(dir);
    const entries = typeof listed === "string" ? [] : listed.entries;
    for (const entry of withGone(entries, input.changes.gone.get(dir))) {
      const path = joinPath(dir, entry.name);
      const expanded = entry.folder && input.expanded.has(path);
      const gone = entry.gone === true;
      const state = gone ? "deleted" : stateAt(input.changes, path);
      const rollup = entry.folder ? input.changes.rollups.get(path) : undefined;
      rows.push({
        path,
        name: entry.name,
        depth,
        folder: entry.folder,
        expanded,
        loading: expanded && !gone && input.listing(path) === "loading",
        ignored: entry.ignored === true,
        heavy: entry.heavy === true,
        link: entry.link === true,
        gone,
        ...(state === undefined ? {} : { state }),
        ...(rollup === undefined ? {} : { rollup }),
      });
      if (expanded) visit(path, depth + 1, gone);
    }
  };
  visit("", 0, false);
  return rows;
};

/** The folders to open so that `path` shows. */
export const toReveal = (path: string): ReadonlyArray<string> => ancestors(path);

// ---------------------------------------------------------------------------------------------
// Changes

/** One line of the list of what changed. */
export interface ChangedRow {
  readonly path: string;
  readonly folder: boolean;
  readonly state?: FileState;
  readonly from?: string;
}

/** What differs from the last commit, by path: git's own view of the folder, whoever changed it. */
export const changedRows = (changes: ChangeIndex): ReadonlyArray<ChangedRow> => {
  const rows = new Map<string, ChangedRow>();
  for (const [path, change] of changes.files) {
    rows.set(path, {
      path,
      folder: false,
      state: change.state,
      ...(change.from === undefined ? {} : { from: change.from }),
    });
  }
  for (const path of changes.newFolders) rows.set(path, { path, folder: true, state: "untracked" });
  return [...rows.values()].toSorted(
    (a, b) => collator.compare(a.path, b.path) || (a.path < b.path ? -1 : 1),
  );
};

// ---------------------------------------------------------------------------------------------
// Keys

/** The row to move to for `typed`, starting after `from`: the next whose name begins with it. */
export const typeAhead = (rows: ReadonlyArray<Row>, from: number, typed: string): number | undefined => {
  if (rows.length === 0 || typed === "") return undefined;
  const wanted = typed.toLowerCase();
  // The same letter again steps through the names that begin with it.
  const repeated = new Set(wanted).size === 1;
  const prefix = repeated ? wanted[0]! : wanted;
  const start = repeated || from < 0 ? from + 1 : from;
  for (let step = 0; step < rows.length; step++) {
    const index = (start + step + rows.length) % rows.length;
    if (rows[index]!.name.toLowerCase().startsWith(prefix)) return index;
  }
  return undefined;
};

/** The row of the folder `index` is in, if any. */
const parentIndex = (rows: ReadonlyArray<Row>, index: number): number | undefined => {
  const depth = rows[index]?.depth ?? 0;
  for (let at = index - 1; at >= 0; at--) if (rows[at]!.depth < depth) return at;
  return undefined;
};

/** What a key does at `index`: where focus goes, or a folder to open or close. */
export type KeyAction =
  | { readonly kind: "focus"; readonly index: number }
  | { readonly kind: "expand" | "collapse"; readonly path: string }
  | { readonly kind: "open"; readonly path: string }
  | { readonly kind: "toggle"; readonly path: string };

/** The tree's keyboard: arrows, Home and End move, Right and Left open and close or step in and out, Enter opens. */
export const keyAction = (rows: ReadonlyArray<Row>, index: number, key: string): KeyAction | undefined => {
  const row = rows[index];
  if (row === undefined) return rows.length === 0 ? undefined : { kind: "focus", index: 0 };
  switch (key) {
    case "ArrowDown":
      return index + 1 < rows.length ? { kind: "focus", index: index + 1 } : undefined;
    case "ArrowUp":
      return index > 0 ? { kind: "focus", index: index - 1 } : undefined;
    case "Home":
      return { kind: "focus", index: 0 };
    case "End":
      return { kind: "focus", index: rows.length - 1 };
    case "ArrowRight": {
      if (!row.folder) return undefined;
      if (!row.expanded) return { kind: "expand", path: row.path };
      return rows[index + 1] !== undefined && rows[index + 1]!.depth > row.depth
        ? { kind: "focus", index: index + 1 }
        : undefined;
    }
    case "ArrowLeft": {
      if (row.folder && row.expanded) return { kind: "collapse", path: row.path };
      const parent = parentIndex(rows, index);
      return parent === undefined ? undefined : { kind: "focus", index: parent };
    }
    case "Enter":
    case " ":
      return row.folder ? { kind: "toggle", path: row.path } : { kind: "open", path: row.path };
    default:
      return undefined;
  }
};
