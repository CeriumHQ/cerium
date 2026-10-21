import { GitRpcs, type FileState, type GitFileChange, type GitStatus } from "@cerium/rpc";
import { Context, Effect, Layer } from "effect";

import { Git, gitFailure, type GitError } from "./git.ts";

// What the Source control panel's Changes shows of a repository and does to it: what's staged and
// what isn't, staging, unstaging and discarding files or lines, and committing. Git does the work, as
// the user's own git does it in a terminal; paths are relative to the repository's top.

/** Changed files listed at once; past it the status says it was cut. */
const MAX_CHANGES = 5_000;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const byPath = (a: GitFileChange, b: GitFileChange) =>
  collator.compare(a.path, b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** What a letter of `git status`'s pair says one side did to a file. */
const sideState = (letter: string): FileState | undefined => {
  switch (letter) {
    case ".":
      return undefined;
    case "A":
    case "C":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      // M, and T for a file that became a link or the other way round.
      return "modified";
  }
};

/** The fields of a `git status --porcelain=v2` line before its path, by the line's kind. */
const FIELDS_BEFORE_PATH: Readonly<Record<string, number>> = { "1": 8, "2": 9, u: 10 };

/**
 * The staged, unstaged and conflicted files `git status --porcelain=v2 -z` lists, each sorted by
 * path; paths are relative to the repository's top.
 */
export const parseStatusV2 = (
  output: string,
): {
  readonly staged: Array<GitFileChange>;
  readonly unstaged: Array<GitFileChange>;
  readonly conflicted: Array<GitFileChange>;
} => {
  const staged: Array<GitFileChange> = [];
  const unstaged: Array<GitFileChange> = [];
  const conflicted: Array<GitFileChange> = [];
  const fields = output.split("\0");
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    const kind = field[0];
    if (kind === "?") {
      const path = field.slice(2);
      if (path !== "") unstaged.push({ path, state: "untracked" });
      continue;
    }
    const before = kind === undefined ? undefined : FIELDS_BEFORE_PATH[kind];
    if (before === undefined) continue;
    const parts = field.split(" ");
    const path = parts.slice(before).join(" ");
    // A rename or copy lists where it came from in the next field.
    const from = kind === "2" ? fields[++index] : undefined;
    if (path === "") continue;
    const pair = parts[1] ?? "..";
    if (kind === "u") {
      conflicted.push({ path, state: "conflicted" });
      continue;
    }
    const index_ = sideState(pair[0] ?? ".");
    if (index_ !== undefined) {
      staged.push({
        path,
        state: index_,
        ...(index_ === "renamed" && from !== undefined && from !== "" ? { from } : {}),
      });
    }
    const worktree = sideState(pair[1] ?? ".");
    // A file added with `git add -N` is new to the work tree's side alone.
    if (worktree !== undefined)
      unstaged.push({ path, state: worktree === "renamed" ? "modified" : worktree });
  }
  return {
    staged: staged.toSorted(byPath),
    unstaged: unstaged.toSorted(byPath),
    conflicted: conflicted.toSorted(byPath),
  };
};

export class GitChanges extends Context.Service<
  GitChanges,
  {
    /** What's staged, what isn't and what's conflicted in the repository `root` is in. */
    status(root: string): Effect.Effect<GitStatus, GitError>;
  }
>()("cerium/backend/GitChanges") {
  /** Requires `Git`. */
  static readonly layer = Layer.effect(
    GitChanges,
    Effect.gen(function* () {
      const git = yield* Git;

      const status = Effect.fn("GitChanges.status")(function* (root: string) {
        const repository = yield* git.repository(root);
        if (repository === undefined)
          return { repository: false, staged: [], unstaged: [], conflicted: [] } satisfies GitStatus;
        const result = yield* git.run(
          repository.top,
          ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
          { look: true },
        );
        if (result.code !== 0 && !result.truncated)
          return yield* gitFailure(result, "Git couldn't say what changed.");
        const { staged, unstaged, conflicted } = parseStatusV2(result.stdout);
        const total = staged.length + unstaged.length + conflicted.length;
        const keep = (list: Array<GitFileChange>, room: number) => list.slice(0, Math.max(0, room));
        const keptConflicted = keep(conflicted, MAX_CHANGES);
        const keptStaged = keep(staged, MAX_CHANGES - keptConflicted.length);
        const keptUnstaged = keep(unstaged, MAX_CHANGES - keptConflicted.length - keptStaged.length);
        return {
          repository: true,
          top: repository.top,
          staged: keptStaged,
          unstaged: keptUnstaged,
          conflicted: keptConflicted,
          ...(result.truncated || total > MAX_CHANGES ? { truncated: true as const } : {}),
        } satisfies GitStatus;
      });

      return GitChanges.of({ status });
    }),
  );
}

/** The Source control panel's calls, served by `GitChanges`. */
export const gitChangesHandlers = (changes: GitChanges["Service"]) =>
  GitRpcs.of({
    GitStatus: ({ root }) => changes.status(root),
  });
