import type {
  Commit,
  CommitDetail,
  CommitPage,
  CommitRef,
  FileChange,
  FileDiff,
  GitError,
} from "@cerium/rpc";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";

import { limitHunks, parseDiff, resolveInside } from "./files.ts";
import { Git, gitFailure } from "./git.ts";

// Source control's History tab: the commits of the branch checked out in a work thread's folder, one
// page at a time, and what each commit changed. Git prints each commit as one record of fields
// separated by unit separators, so a subject or message can hold anything but those two characters.

/** Ends each commit's record in git's output. */
export const RECORD = "\x1e";
/** Separates the fields of a commit's record. */
export const FIELD = "\x1f";

/**
 * The fields of a commit, in the order `parseCommits` reads them: its full and short SHA, its parents,
 * its author's name, when it was authored and committed (in seconds), its refs, and its subject.
 * `%B`, the whole message, comes last when the caller asks for it.
 */
export const COMMIT_FIELDS = ["%H", "%h", "%P", "%an", "%at", "%ct", "%D", "%s"] as const;

/** The format `git log` prints each commit in. Decorations are full ref names, to tell kinds apart. */
const logFormat = (withMessage: boolean) =>
  `--format=${RECORD}${[...COMMIT_FIELDS, ...(withMessage ? ["%B"] : [])].join(FIELD)}`;

/** A commit read from git's output, with what its order and its detail need besides the `Commit`. */
export interface CommitRecord {
  readonly commit: Commit;
  /** When it was committed, in milliseconds: the order `--date-order` lists commits in. */
  readonly committed: number;
  readonly parents: ReadonlyArray<string>;
  /** Its whole message, when the format asked for it. */
  readonly message?: string;
}

/**
 * The refs a `%D` decoration lists, under `--decorate=full`: the checked-out branch as `HEAD -> refs/heads/…`,
 * local branches, tags, and remote-tracking branches (the upstreams). A remote's own `HEAD` is left out.
 */
export const parseRefs = (decorations: string): ReadonlyArray<CommitRef> => {
  const refs: Array<CommitRef> = [];
  for (const piece of decorations.split(", ")) {
    const text = piece.trim();
    // A detached HEAD is just `HEAD`: nothing is checked out by name.
    if (text === "" || text === "HEAD") continue;
    if (text.startsWith("HEAD -> ")) {
      const current = text.slice("HEAD -> ".length);
      if (current.startsWith("refs/heads/"))
        refs.push({ kind: "branch", name: current.slice(11), current: true });
    } else if (text.startsWith("tag: refs/tags/")) {
      refs.push({ kind: "tag", name: text.slice(15) });
    } else if (text.startsWith("refs/heads/")) {
      refs.push({ kind: "branch", name: text.slice(11) });
    } else if (text.startsWith("refs/remotes/") && !text.endsWith("/HEAD")) {
      refs.push({ kind: "upstream", name: text.slice(13) });
    }
  }
  return refs;
};

/** The commits in git's output, in the order it printed them. Records git can't read are skipped. */
export const parseCommits = (output: string, withMessage = false): ReadonlyArray<CommitRecord> => {
  const records: Array<CommitRecord> = [];
  for (const record of output.split(RECORD)) {
    if (record === "") continue;
    const [
      sha = "",
      short = "",
      parents = "",
      author = "",
      at = "",
      committed = "",
      refs = "",
      subject = "",
      ...rest
    ] = record.split(FIELD);
    if (sha === "" || short === "") continue;
    records.push({
      commit: {
        sha,
        short,
        // Git ends each entry with a newline, which the last field of a record carries.
        subject: subject.trimEnd(),
        author,
        at: Number(at) * 1000,
        refs: [...parseRefs(refs)],
      },
      committed: Number(committed) * 1000,
      parents: parents === "" ? [] : parents.split(" "),
      ...(withMessage ? { message: rest.join(FIELD).trim() } : {}),
    });
  }
  return records;
};

/**
 * What `git diff-tree --name-status -z` lists for a commit, under `prefix` (the folder's place in the
 * repository, with a trailing slash): its files inside the folder, relative to it. A rename whose
 * other side is outside the folder shows as added or deleted here.
 */
export const parseNameStatus = (output: string, prefix: string): ReadonlyArray<FileChange> => {
  const fields = output.split("\0");
  const changes: Array<FileChange> = [];
  const within = (path: string) => (path.startsWith(prefix) ? path.slice(prefix.length) : undefined);
  for (let index = 0; index < fields.length; index++) {
    const status = fields[index]!;
    if (status === "") continue;
    const letter = status[0];
    if (letter === "R" || letter === "C") {
      const origin = within(fields[++index] ?? "");
      const path = within(fields[++index] ?? "");
      // Moved out of the folder: the file is gone from it. A copy's source is still there.
      if (path === undefined || path === "") {
        if (letter === "R" && origin !== undefined) changes.push({ path: origin, state: "deleted" });
        continue;
      }
      // A rename from inside the folder; a copy, or a move in from outside it, is a new file here.
      changes.push(
        letter === "R" && origin !== undefined
          ? { path, state: "renamed", from: origin }
          : { path, state: "added" },
      );
      continue;
    }
    const path = within(fields[++index] ?? "");
    if (path === undefined || path === "") continue;
    changes.push({ path, state: letter === "A" ? "added" : letter === "D" ? "deleted" : "modified" });
  }
  return changes;
};

/** Whether `text` is a commit's SHA, full or abbreviated: the only commit names the History tab sends git. */
export const isSha = (text: string) => /^[0-9a-f]{4,64}$/i.test(text);

/**
 * Two lists of commits from one history, each newest first, as one: the commits of both without a
 * repeat, newest first, the first list's copy kept.
 */
export const mergeCommits = (
  first: ReadonlyArray<CommitRecord>,
  second: ReadonlyArray<CommitRecord>,
): ReadonlyArray<CommitRecord> => {
  const seen = new Set<string>();
  const merged: Array<CommitRecord> = [];
  for (const record of [...first, ...second]) {
    if (seen.has(record.commit.sha)) continue;
    seen.add(record.commit.sha);
    merged.push(record);
  }
  // A stable sort keeps the order git printed commits with equal dates in.
  return merged.toSorted((a, b) => b.committed - a.committed);
};

// ---------------------------------------------------------------------------------------------
// The service

/** A request about the history the backend refused; `message` is written for the user. */
export class HistoryError extends Schema.TaggedError<HistoryError>()("HistoryError", {
  message: Schema.String,
}) {}

/** Changed files one commit lists at most. */
const MAX_FILES = 1_000;
/** What may be read of a commit's diff from git, in characters; past it, the diff is cut at a line. */
const DIFF_CHARS = 4 * 1024 * 1024;
/** Lines of a commit's diff that are sent. */
const MAX_DIFF_LINES = 20_000;
/** Unchanged lines around each change, unless the viewer asks for more. */
const DIFF_CONTEXT = 3;

export class History extends Context.Service<
  History,
  {
    /**
     * A page of the commits on the branch checked out in `root`, newest first, from `offset`; with a
     * `query`, those whose message or author holds it.
     */
    commits(
      root: string,
      options: { readonly query?: string; readonly offset: number; readonly limit: number },
    ): Effect.Effect<CommitPage, HistoryError | GitError>;
    /** One commit of `root`'s branch in full, with the files under `root` it changed. */
    detail(root: string, sha: string): Effect.Effect<CommitDetail, HistoryError | GitError>;
    /** A file a commit changed, against its first parent. */
    diff(
      root: string,
      sha: string,
      path: string,
      from?: string,
      context?: number,
    ): Effect.Effect<FileDiff, HistoryError | GitError>;
  }
>()("cerium/backend/History") {
  /** Requires `FileSystem`, `Path` and `Git`. */
  static readonly layer = Layer.effect(
    History,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const repos = yield* Git;

      /** Runs git to look at `cwd`'s repository; an exit with an error is read by the caller. */
      const git = (cwd: string, args: ReadonlyArray<string>) => repos.run(cwd, args, { look: true });

      /** `root` as a folder, or the refusal to say why it isn't one. */
      const folderOf = Effect.fn("History.folderOf")(function* (root: string) {
        const base = path.resolve(root);
        const info = yield* fs
          .stat(base)
          .pipe(Effect.mapError(() => new HistoryError({ message: "That folder is gone." })));
        if (info.type !== "Directory") return yield* new HistoryError({ message: "That isn't a folder." });
        return base;
      });

      /** Where `base` sits in its repository, with a trailing slash; undefined outside git. */
      const prefixOf = (base: string) => repos.repository(base).pipe(Effect.map((found) => found?.prefix));

      /** The commits `args` list from HEAD, newest first, at most `count`. */
      const logged = (base: string, count: number, args: ReadonlyArray<string>) =>
        git(base, [
          "log",
          "--date-order",
          "--decorate=full",
          "-n",
          String(count),
          logFormat(false),
          ...args,
          "HEAD",
          "--",
        ]).pipe(
          Effect.flatMap(({ stdout, stderr, code }) =>
            code === 0
              ? Effect.succeed(parseCommits(stdout))
              : Effect.fail(gitFailure({ stdout, stderr }, "Git couldn't list the commits.")),
          ),
        );

      const commits = Effect.fn("History.commits")(function* (
        root: string,
        {
          query = "",
          offset,
          limit,
        }: { readonly query?: string; readonly offset: number; readonly limit: number },
      ) {
        const base = yield* folderOf(root);
        const prefix = yield* prefixOf(base);
        if (prefix === undefined) return { repository: false, commits: [], more: false } satisfies CommitPage;
        const head = yield* git(base, ["rev-parse", "--verify", "--quiet", "HEAD"]);
        if (head.code !== 0) return { repository: true, commits: [], more: false } satisfies CommitPage;
        // Each list takes its first `want` commits from the top, so the first `want` of the merge are right.
        const want = offset + limit + 1;
        const term = query.trim();
        // `--grep` and `--author` in one call must both match, so each is listed on its own.
        const found =
          term === ""
            ? yield* logged(base, want, [])
            : mergeCommits(
                yield* logged(base, want, [`--grep=${term}`, "--regexp-ignore-case", "--fixed-strings"]),
                yield* logged(base, want, [`--author=${term}`, "--regexp-ignore-case", "--fixed-strings"]),
              );
        // What is on no remote branch is unpushed, but only in a repository that has a remote to push to.
        const remotes = (yield* git(base, ["remote"])).stdout.trim() !== "";
        const unpushed = remotes
          ? new Set(
              (yield* git(base, ["rev-list", "HEAD", "--not", "--remotes"])).stdout
                .split("\n")
                .filter(Boolean),
            )
          : new Set<string>();
        const page = found.slice(offset, offset + limit + 1);
        return {
          repository: true,
          commits: page.slice(0, limit).map(({ commit }) => ({
            ...commit,
            ...(unpushed.has(commit.sha) ? { unpushed: true } : {}),
          })),
          more: page.length > limit,
        } satisfies CommitPage;
      });

      /** One commit read from git, with its message when asked; refused when git doesn't know it. */
      const show = Effect.fn("History.show")(function* (base: string, sha: string, withMessage: boolean) {
        const { stdout, stderr, code } = yield* git(base, [
          "log",
          "--decorate=full",
          "-n",
          "1",
          logFormat(withMessage),
          sha,
          "--",
        ]);
        const [record] = code === 0 ? parseCommits(stdout, withMessage) : [];
        if (record === undefined) {
          return yield* code === 0
            ? new HistoryError({ message: "That commit isn't in this repository." })
            : gitFailure({ stdout, stderr }, "That commit isn't in this repository.");
        }
        return record;
      });

      const detail = Effect.fn("History.detail")(function* (root: string, sha: string) {
        if (!isSha(sha)) return yield* new HistoryError({ message: "That isn't a commit." });
        const base = yield* folderOf(root);
        const prefix = yield* prefixOf(base);
        if (prefix === undefined)
          return yield* new HistoryError({ message: "Git isn't tracking this folder." });
        const record = yield* show(base, sha, true);
        const [parent] = record.parents;
        // A merge is read against its first parent, and the first commit against the empty tree.
        const { stdout, stderr, code } = yield* git(base, [
          "diff-tree",
          "--root",
          "--no-commit-id",
          "-r",
          "-M",
          "-z",
          "--name-status",
          ...(parent === undefined ? [record.commit.sha] : [parent, record.commit.sha]),
          "--",
          ...(prefix === "" ? [] : [prefix]),
        ]);
        if (code !== 0)
          return yield* gitFailure({ stdout, stderr }, "Git couldn't list what the commit changed.");
        const files = parseNameStatus(stdout, prefix);
        return {
          commit: record.commit,
          message: record.message ?? "",
          files: files.slice(0, MAX_FILES),
          ...(files.length > MAX_FILES ? { truncated: true } : {}),
        } satisfies CommitDetail;
      });

      const diff = Effect.fn("History.diff")(function* (
        root: string,
        sha: string,
        relative: string,
        from?: string,
        context: number = DIFF_CONTEXT,
      ) {
        if (!isSha(sha)) return yield* new HistoryError({ message: "That isn't a commit." });
        const base = yield* folderOf(root);
        const prefix = yield* prefixOf(base);
        if (prefix === undefined)
          return yield* new HistoryError({ message: "Git isn't tracking this folder." });
        const target = resolveInside(base, relative);
        const origin = from === undefined ? undefined : resolveInside(base, from);
        if (target === undefined || (from !== undefined && origin === undefined))
          return yield* new HistoryError({ message: "That path isn't inside the thread's folder." });
        const record = yield* show(base, sha, false);
        const [parent] = record.parents;
        const paths = [`${prefix}${relative}`, ...(from === undefined ? [] : [`${prefix}${from}`])];
        const { stdout, stderr, code } = yield* git(base, [
          "diff-tree",
          "--root",
          "--no-commit-id",
          "-p",
          "-M",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          `-U${Math.max(0, Math.floor(context))}`,
          ...(parent === undefined ? [record.commit.sha] : [parent, record.commit.sha]),
          "--",
          ...paths,
        ]);
        if (code !== 0) return yield* gitFailure({ stdout, stderr }, "Git couldn't compare that file.");
        const cut = stdout.length > DIFF_CHARS;
        const { hunks, binary } = parseDiff(
          cut ? stdout.slice(0, stdout.lastIndexOf("\n", DIFF_CHARS)) : stdout,
        );
        const limited = limitHunks(hunks, MAX_DIFF_LINES);
        return {
          hunks: limited.hunks,
          ...(binary ? { binary: true } : {}),
          ...(cut || limited.truncated ? { truncated: true } : {}),
        } satisfies FileDiff;
      });

      return History.of({ commits, detail, diff });
    }),
  );
}
