import type { GitFileChange } from "@cerium/rpc";

// What Source control shows of a repository: its changed files as a tree of the folders they're in.
// Plain functions; the panel feeds them what the machine says.

/** The `RPC_VERSION` that brought Source control's calls; an older machine has no panel. */
export const GIT_VERSION = 17;

/** The three lists of the Changes tab. */
export type ChangeGroup = "conflicted" | "staged" | "unstaged";

/** One line of a group's tree: a folder of changed files, or one of them. */
export type ChangeRow =
  | {
      readonly kind: "folder";
      /** From the repository's top, without a trailing slash. */
      readonly path: string;
      /** The folders it stands for, joined: a folder whose only entry is a folder takes it in. */
      readonly label: string;
      readonly depth: number;
      /** Changed files under it. */
      readonly count: number;
      readonly collapsed: boolean;
    }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly label: string;
      readonly depth: number;
      readonly change: GitFileChange;
    };

interface Folder {
  readonly folders: Map<string, Folder>;
  readonly files: Array<GitFileChange>;
  count: number;
}

const folder = (): Folder => ({ folders: new Map(), files: [], count: 0 });

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const compare = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

export const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const dirOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/**
 * The rows of a group's tree, top to bottom: folders before files, each by name, a folder's entries
 * under it unless it's `collapsed`. A folder holding just one folder shows as one row (`src/app`).
 */
export const changeRows = (
  changes: ReadonlyArray<GitFileChange>,
  collapsed: ReadonlySet<string>,
): ReadonlyArray<ChangeRow> => {
  const top = folder();
  for (const change of changes) {
    const parts = change.path.split("/");
    let at = top;
    at.count++;
    for (const part of parts.slice(0, -1)) {
      let next = at.folders.get(part);
      if (next === undefined) {
        next = folder();
        at.folders.set(part, next);
      }
      next.count++;
      at = next;
    }
    at.files.push(change);
  }
  const rows: Array<ChangeRow> = [];
  const visit = (at: Folder, path: string, depth: number) => {
    for (const name of [...at.folders.keys()].toSorted(compare)) {
      let inner = at.folders.get(name)!;
      let label = name;
      let innerPath = path === "" ? name : `${path}/${name}`;
      while (inner.files.length === 0 && inner.folders.size === 1) {
        const [only, next] = [...inner.folders][0]!;
        label = `${label}/${only}`;
        innerPath = `${innerPath}/${only}`;
        inner = next;
      }
      const shut = collapsed.has(innerPath);
      rows.push({ kind: "folder", path: innerPath, label, depth, count: inner.count, collapsed: shut });
      if (!shut) visit(inner, innerPath, depth + 1);
    }
    for (const change of at.files.toSorted((a, b) => compare(nameOf(a.path), nameOf(b.path)))) {
      rows.push({ kind: "file", path: change.path, label: nameOf(change.path), depth, change });
    }
  };
  visit(top, "", 0);
  return rows;
};

/** The changes of `group` that are `path` or under the folder `path`. */
export const changesUnder = (
  changes: ReadonlyArray<GitFileChange>,
  path: string,
): ReadonlyArray<GitFileChange> =>
  changes.filter((change) => change.path === path || change.path.startsWith(`${path}/`));
