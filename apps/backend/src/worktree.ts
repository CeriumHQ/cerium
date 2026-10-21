import { Worktrees, WorktreeError } from "@cerium/orchestrator";
import type { ThreadWorktree, WorktreeChanges } from "@cerium/protocol";
import { Effect, FileSystem, Layer, Path, Schedule, Semaphore } from "effect";

import { Git, type GitResult } from "./git.ts";
import { Terminals } from "./terminal.ts";

// Each thread that asks for one gets a git worktree of its project's repository, on a branch of its
// own, so threads in one project stop changing each other's files. Git does the work; Cerium picks
// the names, copies in the ignored files the project allows, and cleans up when the thread goes.

/** Branches Cerium makes start with this, so the user can tell them from their own. */
export const BRANCH_PREFIX = "cerium/";

/** The longest a worktree's folder and branch name may be, before a number that tells it apart. */
const MAX_SLUG = 32;

/** The file in a repository's root that lists, in gitignore's syntax, the ignored files a worktree copies. */
export const INCLUDE_FILE = ".worktreeinclude";

/** What a worktree copies when the repository has no `.worktreeinclude`: its environment files. */
export const DEFAULT_INCLUDE: ReadonlyArray<string> = [".env", ".env.*"];

/** Names Windows reserves for devices, which no folder may have. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/;

/** A short folder and branch name from a thread's title: its first words, lowercase, joined by hyphens. */
export const worktreeSlug = (title: string): string => {
  const words =
    title
      .normalize("NFKD")
      .replaceAll(/\p{M}/gu, "")
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [];
  let slug = "";
  for (const word of words) {
    const next = slug === "" ? word : `${slug}-${word}`;
    if (next.length > MAX_SLUG) break;
    slug = next;
  }
  if (slug === "") slug = words[0]?.slice(0, MAX_SLUG) ?? "thread";
  return RESERVED.test(slug) ? `${slug}-thread` : slug;
};

/** How many files `git status --porcelain -z` lists: a rename or copy carries its old path as well. */
export const countStatus = (output: string): number => {
  const fields = output.split("\0");
  let count = 0;
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    if (field.length < 4) continue;
    count++;
    if (field[0] === "R" || field[0] === "C") index++;
  }
  return count;
};

/** Git's own complaint, without its `fatal:` prefix, or `fallback` when it said nothing. */
const complaint = ({ stderr }: GitResult, fallback: string) => {
  const line = stderr
    .split("\n")
    .map((text) => text.trim())
    .findLast((text) => text.startsWith("fatal:") || text.startsWith("error:"));
  return line === undefined ? fallback : line.replace(/^(fatal|error):\s*/, "");
};

/**
 * Worktrees under `directory`, one folder per repository; Windows' path limit is why it isn't the
 * app's own data folder. Requires `FileSystem`, `Path`, `Git` and `Terminals`.
 */
export const worktreesLayer = (options: { readonly directory: string }) =>
  Layer.effect(
    Worktrees,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const gitService = yield* Git;
      const terminals = yield* Terminals;
      /** One worktree is made at a time: threads started together with one title pick their names in turn. */
      const making = yield* Semaphore.make(1);

      // Names are git's own here (`check-ignore` refuses literal pathspecs), never the user's.
      const git = (cwd: string, args: ReadonlyArray<string>, stdin?: string) =>
        gitService
          .run(cwd, args, { pathspecs: true, ...(stdin === undefined ? {} : { stdin }) })
          .pipe(Effect.mapError((error) => new WorktreeError({ message: error.message })));

      /** Runs git and fails with its complaint when it exits with an error. */
      const gitOk = (cwd: string, args: ReadonlyArray<string>, fallback: string) =>
        git(cwd, args).pipe(
          Effect.flatMap((result) =>
            result.code === 0
              ? Effect.succeed(result.stdout)
              : Effect.fail(new WorktreeError({ message: complaint(result, fallback) })),
          ),
        );

      const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));

      const hasBranch = (repo: string, branch: string) =>
        git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).pipe(
          Effect.map(({ code }) => code === 0),
        );

      /**
       * Copies the files the repository's include list names into a worktree: only those git ignores,
       * since the worktree has every tracked file already. Without a list, its environment files.
       */
      const copyIncluded = Effect.fn("Worktrees.copyIncluded")(function* (toplevel: string, root: string) {
        const listFile = path.join(toplevel, INCLUDE_FILE);
        const patterns = (yield* exists(listFile))
          ? [`--exclude-from=${listFile}`]
          : DEFAULT_INCLUDE.map((pattern) => `--exclude=${pattern}`);
        const listed = yield* gitOk(
          toplevel,
          ["ls-files", "-z", "--others", "--ignored", ...patterns],
          "Couldn't list the files to copy",
        );
        const candidates = listed.split("\0").filter((name) => name !== "");
        if (candidates.length === 0) return 0;
        // Untracked files the list names but git doesn't ignore are the user's work in progress.
        const ignored = yield* git(toplevel, ["check-ignore", "-z", "--stdin"], `${candidates.join("\0")}\0`);
        const files = ignored.stdout.split("\0").filter((name) => name !== "");
        yield* Effect.forEach(
          files,
          (file) =>
            Effect.gen(function* () {
              const target = path.join(root, file);
              yield* fs.makeDirectory(path.dirname(target), { recursive: true });
              yield* fs.copyFile(path.join(toplevel, file), target);
            }).pipe(Effect.ignore({ log: "Warn", message: `Couldn't copy ${file} into the worktree` })),
          { concurrency: 16, discard: true },
        );
        return files.length;
      });

      /** Commits on the branch its base doesn't have, read in the repository so a removed worktree still counts. */
      const unmerged = Effect.fn("Worktrees.unmerged")(function* (worktree: ThreadWorktree) {
        const repo = worktree.project;
        if (!(yield* hasBranch(repo, worktree.branch))) return 0;
        const ahead = yield* git(repo, [
          "rev-list",
          "--count",
          `${worktree.base}..refs/heads/${worktree.branch}`,
        ]);
        if (ahead.code === 0) return Number(ahead.stdout.trim()) || 0;
        // The base is gone: what no other branch has is what would be lost.
        const alone = yield* gitOk(
          repo,
          [
            "rev-list",
            "--count",
            `refs/heads/${worktree.branch}`,
            "--not",
            `--exclude=refs/heads/${worktree.branch}`,
            "--branches",
          ],
          `Couldn't compare ${worktree.branch} with the other branches`,
        );
        return Number(alone.trim()) || 0;
      });

      const changes = Effect.fn("Worktrees.changes")(function* (worktree: ThreadWorktree) {
        const uncommitted = (yield* exists(worktree.root))
          ? countStatus(
              yield* gitOk(
                worktree.root,
                ["status", "--porcelain", "-z", "--untracked-files=all"],
                "Couldn't read the worktree's changes",
              ),
            )
          : 0;
        return { uncommitted, unmerged: yield* unmerged(worktree) } satisfies WorktreeChanges;
      });

      /** Checks a worktree out at `worktree.root`, on its branch, or a new one from its base. */
      const checkOut = Effect.fn("Worktrees.checkOut")(function* (
        toplevel: string,
        worktree: ThreadWorktree,
      ) {
        yield* fs
          .makeDirectory(path.dirname(worktree.root), { recursive: true })
          .pipe(
            Effect.mapError(
              () => new WorktreeError({ message: `Couldn't make ${path.dirname(worktree.root)}.` }),
            ),
          );
        yield* git(toplevel, ["worktree", "prune"]);
        yield* gitOk(
          toplevel,
          (yield* hasBranch(toplevel, worktree.branch))
            ? ["worktree", "add", worktree.root, worktree.branch]
            : ["worktree", "add", "-b", worktree.branch, worktree.root, worktree.base],
          "Git couldn't make the worktree",
        );
        yield* copyIncluded(toplevel, worktree.root).pipe(
          Effect.ignore({ log: "Warn", message: "Couldn't copy the included files into the worktree" }),
        );
      });

      return Worktrees.of({
        create: Effect.fn("Worktrees.create")(function* (project: string, name: string) {
          const folder = path.resolve(project);
          const where = yield* git(folder, ["rev-parse", "--show-toplevel", "--show-prefix"]);
          if (where.code !== 0) {
            return yield* new WorktreeError({ message: `${folder} isn't in a git repository.` });
          }
          const [top = "", prefix = ""] = where.stdout.split("\n").map((line) => line.trim());
          const toplevel = path.resolve(top);
          const head = yield* git(toplevel, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
          if (head.code !== 0) {
            return yield* new WorktreeError({
              message: `${path.basename(toplevel)} has no commits yet, so it can't have worktrees.`,
            });
          }
          const branch = yield* git(toplevel, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
          const base = branch.code === 0 ? branch.stdout.trim() : head.stdout.trim();
          // A number tells apart threads with the same title, and repositories with the same name.
          const slug = worktreeSlug(name);
          const home = path.join(options.directory, path.basename(toplevel));
          let attempt = 1;
          let picked = slug;
          while (
            (yield* exists(path.join(home, picked))) ||
            (yield* hasBranch(toplevel, `${BRANCH_PREFIX}${picked}`))
          ) {
            attempt++;
            picked = `${slug}-${attempt}`;
          }
          const worktree: ThreadWorktree = {
            // As the user chose it, so the saved projects list it once.
            project,
            root: path.join(home, picked),
            branch: `${BRANCH_PREFIX}${picked}`,
            base,
          };
          yield* checkOut(toplevel, worktree);
          // Git ends the prefix with a slash.
          return { worktree, cwd: prefix === "" ? worktree.root : path.resolve(worktree.root, prefix) };
        }, making.withPermits(1)),

        changes,

        remove: Effect.fn("Worktrees.remove")(function* (threadId, worktree) {
          // What runs in the folder holds it open on Windows.
          yield* terminals.closeThread(threadId);
          // Unknown counts as unmerged: the branch stays rather than lose commits.
          const keepBranch = yield* unmerged(worktree).pipe(
            Effect.map((count) => count > 0),
            Effect.orElseSucceed(() => true),
          );
          const repo = worktree.project;
          if (yield* exists(worktree.root)) {
            // A harness that just ended can hold a file open for a moment longer.
            const removed = yield* gitOk(repo, ["worktree", "remove", "--force", worktree.root], "").pipe(
              Effect.retry({ times: 3, schedule: Schedule.spaced("500 millis") }),
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
            if (!removed) {
              yield* fs.remove(worktree.root, { recursive: true }).pipe(
                Effect.mapError(
                  () =>
                    new WorktreeError({
                      message: `Couldn't remove ${worktree.root}: something still has files open there.`,
                    }),
                ),
              );
            }
          }
          yield* git(repo, ["worktree", "prune"]);
          if (!keepBranch) yield* git(repo, ["branch", "-D", worktree.branch]);
        }),

        restore: Effect.fn("Worktrees.restore")(function* (worktree) {
          if (yield* exists(worktree.root)) return;
          const where = yield* gitOk(
            worktree.project,
            ["rev-parse", "--show-toplevel"],
            `${worktree.project} isn't in a git repository any more.`,
          );
          yield* checkOut(path.resolve(where.trim()), worktree);
        }),
      });
    }),
  );
