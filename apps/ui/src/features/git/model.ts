import type { DiffHunk, GitFileChange, GitSide, PickedHunk } from "@cerium/rpc";
import { Atom } from "effect/reactivity";

// What Source control shows of a repository and does to it: its changed files as a tree of the folders
// they're in, the lines picked to stage, and the words a discard asks with. Plain functions; the panel
// feeds them what the machine says.

/** The `RPC_VERSION` that brought Source control's calls, staging and committing; an older machine has no panel. */
export const GIT_VERSION = 18;

/**
 * The side of a file's changes its viewer tab shows, by tab key: Source control opens a staged file on
 * what's staged and any other on what isn't. Without one, the viewer compares with the last commit.
 */
export const diffSideAtom = Atom.family((_key: string) =>
  Atom.make<GitSide | undefined>(undefined).pipe(Atom.keepAlive),
);

/** The commit message being written for a repository, by its top, kept while the panel is closed. */
export const commitDraftAtom = Atom.family((_top: string) =>
  Atom.make({ subject: "", body: "", amend: false }).pipe(Atom.keepAlive),
);

/** A commit message from its subject and body, as git takes it. */
export const commitMessage = (subject: string, body: string) =>
  body.trim() === "" ? subject.trim() : `${subject.trim()}\n\n${body.replace(/\s+$/, "")}`;

/** A commit message split at its first line, for the subject and body fields. */
export const splitMessage = (message: string): { readonly subject: string; readonly body: string } => {
  const [subject = "", ...rest] = message.split("\n");
  return { subject, body: rest.join("\n").replace(/^\n+/, "") };
};

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

/** The changes of `group` that are `path` or under the folder `path`; `""` is all of them. */
export const changesUnder = (
  changes: ReadonlyArray<GitFileChange>,
  path: string,
): ReadonlyArray<GitFileChange> =>
  path === ""
    ? changes
    : changes.filter((change) => change.path === path || change.path.startsWith(`${path}/`));

/** The paths unstaging `changes` takes: a renamed file's old name too, so the rename comes out whole. */
export const unstagePaths = (changes: ReadonlyArray<GitFileChange>): ReadonlyArray<string> => [
  ...new Set(
    changes.flatMap((change) => (change.from === undefined ? [change.path] : [change.path, change.from])),
  ),
];

/** How a discard asks first: what it's called, and what is lost. */
export interface DiscardWords {
  readonly title: string;
  readonly description: string;
  readonly confirm: string;
}

/**
 * The question a discard of `changes` asks, saying what is lost: `where` is the folder they're in, or
 * `""` for the whole repository, or undefined for one file.
 */
export const discardWords = (
  changes: ReadonlyArray<GitFileChange>,
  where: string | undefined,
): DiscardWords => {
  const fresh = changes.filter((change) => change.state === "untracked").length;
  const tracked = changes.length - fresh;
  const only = changes.length === 1 ? changes[0] : undefined;
  if (only !== undefined && where === undefined) {
    return only.state === "untracked"
      ? {
          title: `Delete ${nameOf(only.path)}?`,
          description: "It's new, so git has no copy of it. It will be gone for good.",
          confirm: "Delete",
        }
      : {
          title: `Discard changes to ${nameOf(only.path)}?`,
          description:
            only.state === "deleted"
              ? "It comes back as it was last staged."
              : "Its changes that aren't staged are lost for good. What's staged stays.",
          confirm: "Discard",
        };
  }
  const parts = [
    ...(tracked > 0
      ? [tracked === 1 ? "1 file loses its unstaged changes" : `${tracked} files lose their unstaged changes`]
      : []),
    ...(fresh > 0 ? [fresh === 1 ? "1 new file is deleted" : `${fresh} new files are deleted`] : []),
  ];
  return {
    title: where === "" || where === undefined ? "Discard every change?" : `Discard the changes in ${where}?`,
    description: `${parts.join(", and ")}. This can't be undone.`,
    confirm: fresh > 0 && tracked === 0 ? "Delete" : "Discard",
  };
};

// ---------------------------------------------------------------------------------------------
// Picking lines

/** A changed line of a diff, by its hunk's index and its own within the hunk. */
export const lineId = (hunk: number, line: number) => `${hunk}:${line}`;

/** Every changed line from `from` to `to`, whichever comes first, both included. */
export const linesBetween = (
  hunks: ReadonlyArray<DiffHunk>,
  from: string,
  to: string,
): ReadonlyArray<string> => {
  const changed = hunks.flatMap((hunk, at) =>
    hunk.lines.flatMap((line, index) => (line.kind === "context" ? [] : [lineId(at, index)])),
  );
  const start = changed.indexOf(from);
  const end = changed.indexOf(to);
  if (start === -1 || end === -1) return [to];
  return changed.slice(Math.min(start, end), Math.max(start, end) + 1);
};

/** The changed lines of one hunk. */
export const hunkLines = (hunks: ReadonlyArray<DiffHunk>, hunk: number): ReadonlyArray<string> =>
  (hunks[hunk]?.lines ?? []).flatMap((line, index) => (line.kind === "context" ? [] : [lineId(hunk, index)]));

/** The diff as `ApplyLines` takes it back: every line, each with whether it's picked. */
export const pickedHunks = (
  hunks: ReadonlyArray<DiffHunk>,
  picked: ReadonlySet<string>,
): ReadonlyArray<PickedHunk> =>
  hunks.map((hunk, at) => ({
    oldStart: hunk.oldStart,
    newStart: hunk.newStart,
    lines: hunk.lines.map((line, index) => ({
      kind: line.kind,
      text: line.text,
      picked: line.kind !== "context" && picked.has(lineId(at, index)),
    })),
  }));
