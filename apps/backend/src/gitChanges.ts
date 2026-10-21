import {
  GitRpcs,
  type DiffLine,
  type FileDiff,
  type FileState,
  type GitFileChange,
  type GitSide,
  type GitStatus,
  type MadeCommit,
  type PickedHunk,
} from "@cerium/rpc";
import { Context, Effect, FileSystem, Layer, Path } from "effect";

import type { Drafts } from "./drafts.ts";
import { DIFF_BYTES, DIFF_CONTEXT, fileDiffOf, parseDiff, pathSegments } from "./files.ts";
import { explainGit, Git, gitComplaint, GitError, gitFailure } from "./git.ts";

// What the Source control panel's Changes shows of a repository and does to it: what's staged and
// what isn't, staging, unstaging and discarding files or lines, and committing. Git does the work, as
// the user's own git does it in a terminal; paths are relative to the repository's top.

/** Changed files listed at once; past it the status says it was cut. */
const MAX_CHANGES = 5_000;
/** How long a commit may take, its hooks included, before it is stopped. */
const COMMIT_TIMEOUT = "10 minutes";

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

/** The folders a path from the top is in, nearest first, the top left out. */
export const parentFolders = (path: string): ReadonlyArray<string> => {
  const folders: Array<string> = [];
  for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1))
    folders.push(path.slice(0, at));
  return folders;
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

// ---------------------------------------------------------------------------------------------
// Lines of a diff

/** A line of git's diff as the file has it: with any carriage return, and whether the file ends there without a newline. */
interface RawLine {
  readonly kind: DiffLine["kind"];
  readonly raw: string;
  readonly noNewline: boolean;
}

interface RawHunk {
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: ReadonlyArray<RawLine>;
}

/** The hunks of one file's unified diff, each line as the file has it; `parseDiff` lists the same lines. */
export const rawHunks = (output: string): ReadonlyArray<RawHunk> => {
  const hunks: Array<{ oldStart: number; newStart: number; lines: Array<RawLine> }> = [];
  let current: (typeof hunks)[number] | undefined;
  for (const line of output.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
      hunks.push(current);
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith("diff --git ")) {
      current = undefined;
      continue;
    }
    const kind =
      line[0] === "+" ? "added" : line[0] === "-" ? "removed" : line[0] === " " ? "context" : undefined;
    if (kind !== undefined) current.lines.push({ kind, raw: line.slice(1), noNewline: false });
    else if (line.startsWith("\\") && current.lines.length > 0)
      current.lines[current.lines.length - 1] = { ...current.lines.at(-1)!, noNewline: true };
  }
  return hunks;
};

/** The diff git gives now is the one the user picked lines of. */
export const sameHunks = (output: string, sent: ReadonlyArray<PickedHunk>): boolean => {
  const { hunks } = parseDiff(output);
  return (
    hunks.length === sent.length &&
    hunks.every((hunk, index) => {
      const other = sent[index]!;
      return (
        hunk.oldStart === other.oldStart &&
        hunk.newStart === other.newStart &&
        hunk.lines.length === other.lines.length &&
        hunk.lines.every(
          (line, at) => line.kind === other.lines[at]!.kind && line.text === other.lines[at]!.text,
        )
      );
    })
  );
};

/** What would break a patch's line of names, and which git quotes them for. */
// The control characters are the point of the pattern.
// oxlint-disable-next-line no-control-regex
const UNQUOTABLE = /["\\\u0000-\u001f\u007f]/g;

const ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  "\\": "\\\\",
  "\t": "\\t",
  "\n": "\\n",
  "\r": "\\r",
};

/** `path` as a patch names it: quoted the way git quotes, when it holds what would break the line. */
const patchName = (prefix: string, path: string) => {
  const name = `${prefix}${path}`;
  if (name.search(UNQUOTABLE) === -1) return name;
  const escaped = name.replace(
    UNQUOTABLE,
    (character) => ESCAPES[character] ?? `\\${character.charCodeAt(0).toString(8).padStart(3, "0")}`,
  );
  return `"${escaped}"`;
};

/**
 * A patch of the lines picked in `hunks`, or undefined when no changed line is. Applied as it is, it
 * makes the diff's old side take them; `reverse`d, it takes them out of the new side. Either way the
 * side it applies to keeps the lines nobody picked as they are there.
 */
export const linePatch = (
  path: string,
  hunks: ReadonlyArray<RawHunk>,
  picked: ReadonlyArray<ReadonlyArray<boolean>>,
  reverse: boolean,
): string | undefined => {
  const body: Array<string> = [];
  // How many more lines the new side has than the old one, by the hunks so far.
  let offset = 0;
  hunks.forEach((hunk, index) => {
    const lines: Array<string> = [];
    let oldCount = 0;
    let newCount = 0;
    let changed = false;
    for (const [at, line] of hunk.lines.entries()) {
      const pick = picked[index]?.[at] === true;
      // A change nobody picked stays as the side the patch applies to has it.
      const prefix =
        line.kind === "context"
          ? " "
          : pick
            ? line.kind === "added"
              ? "+"
              : "-"
            : (line.kind === "added") === reverse
              ? " "
              : undefined;
      if (prefix === undefined) continue;
      if (prefix !== " ") changed = true;
      if (prefix !== "+") oldCount++;
      if (prefix !== "-") newCount++;
      lines.push(`${prefix}${line.raw}`);
      if (line.noNewline) lines.push("\\ No newline at end of file");
    }
    if (!changed) return;
    // Where each side begins, from 1; git names an empty side by the line before it.
    const count = (kind: DiffLine["kind"]) => hunk.lines.filter((line) => line.kind !== kind).length;
    const begin = (start: number, size: number) => (size === 0 ? start + 1 : start);
    const oldBegin = reverse
      ? begin(hunk.newStart, count("removed")) - offset
      : begin(hunk.oldStart, count("added"));
    const newBegin = reverse ? begin(hunk.newStart, count("removed")) : oldBegin + offset;
    const header = (start: number, size: number) => `${size === 0 ? start - 1 : start},${size}`;
    body.push(`@@ -${header(oldBegin, oldCount)} +${header(newBegin, newCount)} @@`, ...lines);
    offset += newCount - oldCount;
  });
  if (body.length === 0) return undefined;
  const a = patchName("a/", path);
  const b = patchName("b/", path);
  return [`diff --git ${a} ${b}`, `--- ${a}`, `+++ ${b}`, ...body, ""].join("\n");
};

// ---------------------------------------------------------------------------------------------
// Commits

/** What git does on its own when a commit fails, in words for the user; undefined when it isn't git's. */
const commitComplaint = (output: string): string | undefined => {
  if (/nothing (?:added )?to commit|no changes added to commit/i.test(output))
    return "Nothing is staged to commit.";
  if (/unmerged files|unresolved conflict/i.test(output))
    return "Settle the conflicted files and stage them before committing.";
  if (/empty commit message/i.test(output)) return "Write a message for the commit.";
  if (/nothing to amend/i.test(output)) return "There's no commit to amend yet.";
  const explained = explainGit(output, "");
  // `explainGit` falls back to git's last complaint, which a hook's output may hold too.
  return explained === "" || explained === gitComplaint(output) ? undefined : explained;
};

/** The hooks that can stop a commit, by the order git runs them. */
const COMMIT_HOOKS = ["pre-commit", "prepare-commit-msg", "commit-msg"] as const;

export class GitChanges extends Context.Service<
  GitChanges,
  {
    /** What's staged, what isn't and what's conflicted in the repository `root` is in. */
    status(root: string): Effect.Effect<GitStatus, GitError>;
    /** One side of a changed file's diff; `path` and `from` are from the repository's top. */
    diff(
      root: string,
      path: string,
      side: GitSide,
      from?: string,
      context?: number,
    ): Effect.Effect<FileDiff, GitError>;
    /** Stages everything under `paths`, `""` being the whole repository. */
    stage(root: string, paths: ReadonlyArray<string>): Effect.Effect<void, GitError>;
    /** Takes what's staged under `paths` out of the next commit. */
    unstage(root: string, paths: ReadonlyArray<string>): Effect.Effect<void, GitError>;
    /** Throws away what isn't staged under `paths`: changes go back to what's staged, new files go. */
    discard(root: string, paths: ReadonlyArray<string>): Effect.Effect<void, GitError>;
    /** Stages, unstages or discards the picked lines of `path`, as `ApplyLines` says. */
    applyLines(
      root: string,
      path: string,
      action: "stage" | "unstage" | "discard",
      hunks: ReadonlyArray<PickedHunk>,
      context?: number,
    ): Effect.Effect<void, GitError>;
    /** Commits what's staged, or everything with `all`, or amends the last commit. */
    commit(
      root: string,
      message: string,
      options?: { readonly amend?: boolean | undefined; readonly all?: boolean | undefined },
    ): Effect.Effect<MadeCommit, GitError>;
    /** The last commit's message; empty before the first commit. */
    lastMessage(root: string): Effect.Effect<string, GitError>;
  }
>()("cerium/backend/GitChanges") {
  /** Requires `Git`, `FileSystem` and `Path`. */
  static readonly layer = Layer.effect(
    GitChanges,
    Effect.gen(function* () {
      const git = yield* Git;
      const fs = yield* FileSystem.FileSystem;
      const pathApi = yield* Path.Path;

      /** The paths a request names, as git takes them from the top: `.` for the whole repository. */
      const pathspecs = (paths: ReadonlyArray<string>) =>
        Effect.forEach(paths, (path) => {
          const segments = pathSegments(path);
          return segments === undefined
            ? Effect.fail(new GitError({ message: "That path isn't inside the repository." }))
            : Effect.succeed(segments.join("/") || ".");
        });

      const filePath = (path: string) =>
        Effect.flatMap(pathspecs([path]), ([spec]) =>
          spec === "."
            ? Effect.fail(new GitError({ message: "Name a file of the repository." }))
            : Effect.succeed(spec!),
        );

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

      const diffArgs = (path: string, side: GitSide, context: number, from?: string) =>
        side === "staged"
          ? [
              "diff",
              "--cached",
              "--no-color",
              "--no-ext-diff",
              "--no-textconv",
              "-M",
              `-U${context}`,
              "--",
              path,
              ...(from === undefined ? [] : [from]),
            ]
          : ["diff", "--no-color", "--no-ext-diff", "--no-textconv", `-U${context}`, "--", path];

      const diff = Effect.fn("GitChanges.diff")(function* (
        root: string,
        path: string,
        side: GitSide,
        from?: string,
        context: number = DIFF_CONTEXT,
      ) {
        const { top } = yield* git.requireRepository(root);
        const spec = yield* filePath(path);
        const origin = from === undefined ? undefined : yield* filePath(from);
        const lines = Math.max(0, Math.floor(context));
        const failed = "Git couldn't compare that file.";
        const result = yield* git.run(top, diffArgs(spec, side, lines, origin), {
          look: true,
          limit: DIFF_BYTES,
        });
        if (result.code !== 0 && !result.truncated) return yield* gitFailure(result, failed);
        if (side === "staged" || result.stdout !== "") return fileDiffOf(result.stdout, result.truncated);
        // Nothing unstaged to compare: the file is unchanged, or new to git, whose whole text is then new.
        const untracked = yield* git.run(
          top,
          ["ls-files", "-z", "--others", "--exclude-standard", "--", spec],
          {
            look: true,
          },
        );
        if (untracked.stdout === "") return fileDiffOf("", false);
        const added = yield* git.run(
          top,
          [
            "diff",
            "--no-index",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            `-U${lines}`,
            "--",
            "/dev/null",
            spec,
          ],
          { look: true, limit: DIFF_BYTES },
        );
        // A diff of two files exits with 1 when they differ.
        if (added.code > 1 && !added.truncated) return yield* gitFailure(added, failed);
        return fileDiffOf(added.stdout, added.truncated);
      });

      const stage = Effect.fn("GitChanges.stage")(function* (root: string, paths: ReadonlyArray<string>) {
        const { top } = yield* git.requireRepository(root);
        const specs = yield* pathspecs(paths);
        yield* git.change(top, ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], {
          stdin: specs.join("\0"),
          fallback: "Git couldn't stage those files.",
        });
      });

      const unstage = Effect.fn("GitChanges.unstage")(function* (root: string, paths: ReadonlyArray<string>) {
        const { top } = yield* git.requireRepository(root);
        const specs = yield* pathspecs(paths);
        // `reset` takes a file back to the last commit's in the index, or out of it before the first.
        yield* git.change(top, ["reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"], {
          stdin: specs.join("\0"),
          fallback: "Git couldn't unstage those files.",
        });
      });

      const discard = Effect.fn("GitChanges.discard")(function* (root: string, paths: ReadonlyArray<string>) {
        const { top } = yield* git.requireRepository(root);
        const specs = yield* pathspecs(paths);
        const under = (path: string) =>
          specs.some((spec) => spec === "." || path === spec || path.startsWith(`${spec}/`));
        const listed = yield* git.run(top, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], {
          look: true,
        });
        if (listed.code !== 0) return yield* gitFailure(listed, "Git couldn't say what changed.");
        const changed = parseStatusV2(listed.stdout).unstaged.filter((change) => under(change.path));
        const tracked = changed.filter((change) => change.state !== "untracked").map((change) => change.path);
        // `restore` refuses a path git doesn't know, so it takes only the files that are git's.
        if (tracked.length > 0)
          yield* git.change(top, ["restore", "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"], {
            stdin: tracked.join("\0"),
            fallback: "Git couldn't discard those changes.",
          });
        const fresh = changed.filter((change) => change.state === "untracked").map((change) => change.path);
        if (fresh.length === 0) return;
        // Without `-x`, what git ignores stays; without a second `-f`, so does a repository inside.
        yield* git.change(top, ["clean", "-f", "-d", "-q", "--", ...specs], {
          fallback: "Git couldn't delete the new files.",
        });
        // A folder that held only new files goes with them, deepest first so its own folder can follow.
        const folders = new Set(fresh.flatMap((file) => parentFolders(file)));
        for (const folder of [...folders].toSorted((a, b) => b.split("/").length - a.split("/").length)) {
          const full = pathApi.join(top, folder);
          const entries = yield* fs.readDirectory(full).pipe(Effect.orElseSucceed(() => undefined));
          // Removing a folder takes `recursive`, though it was just found empty.
          if (entries?.length === 0) yield* fs.remove(full, { recursive: true }).pipe(Effect.ignore);
        }
      });

      const applyLines = Effect.fn("GitChanges.applyLines")(function* (
        root: string,
        path: string,
        action: "stage" | "unstage" | "discard",
        hunks: ReadonlyArray<PickedHunk>,
        context: number = DIFF_CONTEXT,
      ) {
        const { top } = yield* git.requireRepository(root);
        const spec = yield* filePath(path);
        const lines = Math.max(0, Math.floor(context));
        const side: GitSide = action === "unstage" ? "staged" : "unstaged";
        const result = yield* git.run(top, diffArgs(spec, side, lines), { look: true, limit: DIFF_BYTES });
        if (result.truncated)
          return yield* new GitError({
            message: "That file's diff is too long to pick lines of. Stage it whole.",
          });
        if (result.code !== 0) return yield* gitFailure(result, "Git couldn't compare that file.");
        if (
          /^(?:new file mode|deleted file mode|rename from|Binary files|GIT binary patch)/m.test(
            result.stdout,
          )
        )
          return yield* new GitError({
            message: "Lines can be picked in a changed file. Stage a new, deleted or renamed one whole.",
          });
        if (!sameHunks(result.stdout, hunks))
          return yield* new GitError({
            message: "The file changed since it was shown. Pick its lines again.",
          });
        const patch = linePatch(
          spec,
          rawHunks(result.stdout),
          hunks.map((hunk) => hunk.lines.map((line) => line.picked)),
          action !== "stage",
        );
        if (patch === undefined) return yield* new GitError({ message: "Pick a changed line first." });
        yield* git.change(
          top,
          [
            "apply",
            ...(action === "discard" ? [] : ["--cached"]),
            ...(action === "stage" ? [] : ["--reverse"]),
            "--whitespace=nowarn",
            ...(lines === 0 ? ["--unidiff-zero"] : []),
            "-",
          ],
          { stdin: patch, fallback: `Git couldn't ${action} those lines.` },
        );
      });

      /** The hooks of the repository at `top` that can stop a commit. */
      const commitHooks = Effect.fn("GitChanges.commitHooks")(function* (top: string) {
        const result = yield* git.run(
          top,
          ["rev-parse", ...COMMIT_HOOKS.flatMap((hook) => ["--git-path", `hooks/${hook}`])],
          { look: true },
        );
        if (result.code !== 0) return [];
        const paths = result.stdout.split("\n").map((line) => line.trim());
        const found = yield* Effect.forEach(COMMIT_HOOKS, (hook, index) => {
          const relative = paths[index];
          return relative === undefined || relative === ""
            ? Effect.undefined
            : fs.exists(pathApi.resolve(top, relative)).pipe(
                Effect.map((exists) => (exists ? hook : undefined)),
                Effect.orElseSucceed(() => undefined),
              );
        });
        return found.filter((hook) => hook !== undefined);
      });

      /** A failed commit's error in words for the user: git's own reason, or the hook that stopped it. */
      const commitFailure = Effect.fn("GitChanges.commitFailure")(function* (top: string, error: GitError) {
        const output = error.output;
        if (output === undefined) return error;
        const own = commitComplaint(output);
        if (own !== undefined) return new GitError({ message: own, output });
        const hooks = yield* commitHooks(top);
        if (hooks.length === 0) return error;
        return new GitError({
          message:
            hooks.length === 1
              ? `The ${hooks[0]} hook stopped the commit.`
              : `A ${hooks.join(" or ")} hook stopped the commit.`,
          output,
        });
      });

      const commit = Effect.fn("GitChanges.commit")(function* (
        root: string,
        message: string,
        options: { readonly amend?: boolean | undefined; readonly all?: boolean | undefined } = {},
      ) {
        const { top } = yield* git.requireRepository(root);
        const amend = options.amend === true;
        const keep = message.trim() === "";
        if (keep && !amend) return yield* new GitError({ message: "Write a message for the commit." });
        if (options.all === true)
          yield* git.change(top, ["add", "-A", "--", "."], { fallback: "Git couldn't stage the changes." });
        yield* git
          .change(top, ["commit", ...(amend ? ["--amend"] : []), ...(keep ? ["--no-edit"] : ["-F", "-"])], {
            ...(keep ? {} : { stdin: message }),
            // A hook may run the tests.
            timeout: COMMIT_TIMEOUT,
            fallback: "Git couldn't make the commit.",
          })
          .pipe(Effect.catch((error) => Effect.flatMap(commitFailure(top, error), Effect.fail)));
        const made = yield* git.run(top, ["log", "-1", "--format=%h%x00%s"], { look: true });
        const [hash = "", subject = ""] = made.stdout.replace(/\n$/, "").split("\0");
        if (made.code !== 0 || hash === "")
          return yield* gitFailure(made, "Git made the commit but couldn't say which it is.");
        return { commit: hash, subject } satisfies MadeCommit;
      });

      const lastMessage = Effect.fn("GitChanges.lastMessage")(function* (root: string) {
        const { top } = yield* git.requireRepository(root);
        const result = yield* git.run(top, ["log", "-1", "--format=%B"], { look: true });
        if (result.code === 0) return result.stdout.replace(/\s+$/, "");
        // Before the first commit there's no message to take.
        if (/does not have any commits|unknown revision|bad default revision/i.test(result.stderr)) return "";
        return yield* gitFailure(result, "Git couldn't read the last commit.");
      });

      return GitChanges.of({ status, diff, stage, unstage, discard, applyLines, commit, lastMessage });
    }),
  );
}

/** The Source control panel's calls, served by `GitChanges`, and its commit messages by `Drafts`. */
export const gitChangesHandlers = (changes: GitChanges["Service"], drafts: Drafts["Service"]) =>
  GitRpcs.of({
    GitStatus: ({ root }) => changes.status(root),
    GitDiff: ({ root, path, side, from, context }) => changes.diff(root, path, side, from, context),
    StageFiles: ({ root, paths }) => changes.stage(root, paths),
    UnstageFiles: ({ root, paths }) => changes.unstage(root, paths),
    DiscardFiles: ({ root, paths }) => changes.discard(root, paths),
    ApplyLines: ({ root, path, action, hunks, context }) =>
      changes.applyLines(root, path, action, hunks, context),
    Commit: ({ root, message, amend, all }) => changes.commit(root, message, { amend, all }),
    LastCommitMessage: ({ root }) => Effect.map(changes.lastMessage(root), (message) => ({ message })),
    DraftCommitMessage: ({ root, amend, draft }) =>
      Effect.map(drafts.commitMessage(root, { amend, draft }), (message) => ({ message })),
  });
