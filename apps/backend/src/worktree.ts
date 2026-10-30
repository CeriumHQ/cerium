import { Worktrees, WorktreeError } from "@cerium/orchestrator";
import type { ThreadWorktree, WorktreeChanges } from "@cerium/protocol";
import { Deferred, Effect, Exit, FileSystem, Layer, Option, Path, Schedule, Scope, Semaphore } from "effect";
import { GitHub } from "./github.ts";

import { Git, type GitResult } from "./git.ts";
import { Terminals } from "./terminal.ts";
import { includeList } from "./worktreeInclude.ts";
import { createHash } from "node:crypto";

export const checkoutId = (root: string) =>
  createHash("sha256")
    .update(process.platform === "win32" ? root.toLowerCase().replaceAll("\\", "/") : root)
    .digest("hex")
    .slice(0, 24);

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
      const github = yield* Effect.serviceOption(GitHub);
      const terminals = yield* Terminals;
      const layerScope = yield* Scope.Scope;
      /** Names are picked one at a time: threads started together with one title get one each. */
      const picking = yield* Semaphore.make(1);
      /** The roots of worktrees picked and not yet checked out, which no other may take. */
      const planned = new Set<string>();
      /** Where a removed worktree's folder goes to be deleted behind the thread that had it. */
      const removing = path.join(options.directory, ".removing");

      const git = (cwd: string, args: ReadonlyArray<string>) =>
        gitService
          .run(cwd, args)
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
       * since the worktree has every tracked file already, and never over a file the worktree has.
       * Without a list, its environment files. Git lists what it ignores without going into ignored
       * folders (asking it to match the list walks every one, node_modules too, and took a minute),
       * and only those a line reaches into are looked through. Resolves with what was copied, relative
       * to the root; a folder copied whole ends in a slash.
       */
      const copyIncluded = Effect.fn("Worktrees.copyIncluded")(function* (toplevel: string, root: string) {
        const listFile = path.join(toplevel, INCLUDE_FILE);
        const list = includeList(
          (yield* exists(listFile))
            ? (yield* fs.readFileString(listFile).pipe(Effect.orElseSucceed(() => ""))).split(/\r?\n/)
            : DEFAULT_INCLUDE,
        );
        const listed = yield* gitOk(
          toplevel,
          ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
          "Couldn't list the files git ignores",
        );
        const picked: Array<string> = [];
        const pick = (entry: string): Effect.Effect<void> =>
          Effect.gen(function* () {
            const folder = entry.endsWith("/");
            const name = folder ? entry.slice(0, -1) : entry;
            if (list.includes(name, folder)) return void picked.push(entry);
            if (!folder || !list.reachesInto(name)) return;
            const children = yield* fs
              .readDirectory(path.join(toplevel, name))
              .pipe(Effect.orElseSucceed((): Array<string> => []));
            for (const child of children.toSorted()) {
              const info = yield* fs.stat(path.join(toplevel, name, child)).pipe(Effect.option);
              if (Option.isNone(info)) continue;
              yield* pick(`${name}/${child}${info.value.type === "Directory" ? "/" : ""}`);
            }
          });
        for (const entry of listed.split("\0")) if (entry !== "") yield* pick(entry);
        const copied = yield* Effect.forEach(
          picked,
          (entry) =>
            Effect.gen(function* () {
              const target = path.join(root, entry);
              if (yield* exists(target)) return [];
              yield* fs.makeDirectory(path.dirname(target), { recursive: true });
              const source = path.join(toplevel, entry);
              yield* entry.endsWith("/") ? fs.copy(source, target) : fs.copyFile(source, target);
              return [entry];
            }).pipe(
              Effect.catch(() =>
                Effect.logWarning(`Couldn't copy ${entry} into the worktree`).pipe(Effect.as([])),
              ),
            ),
          { concurrency: 16 },
        );
        return copied.flat();
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
        const uncommitted = (yield* exists(path.join(worktree.root, ".git")))
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

      /** The root of the repository `project` is in. */
      const toplevelOf = (project: string) =>
        gitOk(
          project,
          ["rev-parse", "--show-toplevel"],
          `${project} isn't in a git repository any more.`,
        ).pipe(Effect.map((top) => path.resolve(top.trim())));

      /** Deletes a removed worktree's folder, moved aside already, with what nobody holds open any more. */
      const clear = (folder: string) =>
        fs.remove(folder, { recursive: true, force: true }).pipe(
          Effect.retry({ times: 5, schedule: Schedule.spaced("2 seconds") }),
          Effect.catch(() =>
            Effect.logWarning(`Couldn't delete ${folder}; it goes when Cerium next starts.`),
          ),
        );

      /** Worktree folders still being deleted where they are, by root, which a checkout there waits for. */
      const leaving = new Map<string, Deferred.Deferred<void>>();

      /**
       * Deletes a removed worktree's folder that couldn't be moved aside: a process still running in it
       * (a dev server an agent left behind, say) holds it on Windows. Each pass deletes what nobody holds,
       * then moves the rest aside once it's let go, for up to 10 minutes.
       */
      const clearInPlace = (root: string) =>
        Effect.gen(function* () {
          const done = yield* Deferred.make<void>();
          leaving.set(root, done);
          const aside = path.join(removing, `${path.basename(root)}-${Date.now().toString(36)}`);
          yield* fs.rename(root, aside).pipe(
            Effect.andThen(clear(aside)),
            Effect.catch(() => fs.remove(root, { recursive: true, force: true })),
            Effect.retry({ times: 200, schedule: Schedule.spaced("3 seconds") }),
            Effect.catch(() =>
              Effect.logWarning(`Couldn't delete ${root}: something still has files open there.`),
            ),
            Effect.ensuring(
              Effect.suspend(() => {
                if (leaving.get(root) === done) leaving.delete(root);
                return Deferred.done(done, Exit.void);
              }),
            ),
          );
        });

      /** Waits for a folder still being deleted at `root`, then clears what's left of it; fails while it's held. */
      const vacate = Effect.fn("Worktrees.vacate")(function* (root: string) {
        const pending = leaving.get(root);
        if (pending !== undefined) yield* Deferred.await(pending);
        if (!(yield* exists(root))) return;
        yield* fs.remove(root, { recursive: true, force: true }).pipe(
          Effect.mapError(
            () =>
              new WorktreeError({
                message: `Couldn't check the worktree out again at ${root}: something still has files open there.`,
              }),
          ),
        );
      });

      // What a removal moved aside before Cerium last quit.
      yield* fs.readDirectory(removing).pipe(
        Effect.flatMap((left) =>
          Effect.forEach(left, (name) => clear(path.join(removing, name)), { discard: true }),
        ),
        Effect.ignore,
        Effect.forkIn(layerScope),
      );

      /** Checks a worktree out at `worktree.root`, on its branch, or a new one from its base. */
      const checkOut = Effect.fn("Worktrees.checkOut")(function* (
        toplevel: string,
        worktree: ThreadWorktree,
      ) {
        if (yield* exists(path.join(worktree.root, ".git"))) return [];
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
            : [
                "worktree",
                "add",
                "-b",
                worktree.branch,
                worktree.root,
                worktree.startCommit ?? worktree.baseCommit ?? worktree.base,
              ],
          "Git couldn't make the worktree",
        );
        return yield* copyIncluded(toplevel, worktree.root).pipe(
          Effect.catch(() =>
            Effect.logWarning("Couldn't copy the included files into the worktree").pipe(
              Effect.as([] as ReadonlyArray<string>),
            ),
          ),
        );
      });

      return Worktrees.of({
        plan: Effect.fn("Worktrees.plan")(function* (project, name, choice) {
          const folder = path.resolve(project);
          const where = yield* git(folder, ["rev-parse", "--show-toplevel", "--show-prefix"]);
          if (where.code !== 0) {
            return yield* new WorktreeError({ message: `${folder} isn't in a git repository.` });
          }
          const [top = "", prefix = ""] = where.stdout.split("\n").map((line) => line.trim());
          const toplevel = path.resolve(top);
          if (choice?.path !== undefined) {
            const root = path.resolve(choice.path);
            const actualRoot = yield* gitOk(
              root,
              ["rev-parse", "--show-toplevel"],
              "This checkout is unavailable. Select another workspace.",
            );
            const canonical = (value: string) =>
              process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
            if (canonical(root) !== canonical(actualRoot.trim()))
              return yield* new WorktreeError({
                message: "Choose the checkout's root folder, rather than a subfolder.",
              });
            const common = yield* gitOk(
              toplevel,
              ["rev-parse", "--path-format=absolute", "--git-common-dir"],
              "Couldn't identify the project.",
            );
            const other = yield* gitOk(
              root,
              ["rev-parse", "--path-format=absolute", "--git-common-dir"],
              "This checkout is unavailable. Select another workspace.",
            );
            if (canonical(common.trim()) !== canonical(other.trim()))
              return yield* new WorktreeError({ message: "That checkout belongs to another repository." });
            const ref = yield* gitOk(
              root,
              ["symbolic-ref", "--quiet", "--short", "HEAD"],
              "Choose a checkout on a branch, rather than a detached commit.",
            );
            const commit = yield* gitOk(root, ["rev-parse", "HEAD"], "Couldn't read the checkout's commit.");
            return {
              worktree: {
                id: checkoutId(root),
                managed: false,
                project,
                root,
                branch: ref.trim(),
                base: choice.baseRef ?? ref.trim(),
                baseCommit: commit.trim(),
              },
              cwd: prefix === "" ? root : path.resolve(root, prefix),
            };
          }
          const head = yield* git(toplevel, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
          if (head.code !== 0) {
            return yield* new WorktreeError({
              message: `${path.basename(toplevel)} has no commits yet, so it can't have worktrees.`,
            });
          }
          const branch = yield* git(toplevel, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
          let base = choice?.baseRef ?? (branch.code === 0 ? branch.stdout.trim() : head.stdout.trim());
          let baseCommit = yield* gitOk(
            toplevel,
            ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`],
            "The selected base doesn't exist. Fetch or select another branch.",
          );
          if (choice?.pullRequestUrl !== undefined) {
            if (Option.isNone(github))
              return yield* new WorktreeError({
                message: "GitHub isn't available to prepare this pull request.",
              });
            const repository = yield* github.value
              .repository(toplevel)
              .pipe(Effect.mapError((error) => new WorktreeError({ message: error.message })));
            const pullUrl = yield* Effect.try({
              try: () => new URL(choice.pullRequestUrl!),
              catch: () => new WorktreeError({ message: "Enter a complete GitHub pull request URL." }),
            });
            const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(pullUrl.pathname);
            if (
              pullUrl.protocol !== "https:" ||
              pullUrl.username ||
              pullUrl.password ||
              pullUrl.search ||
              pullUrl.hash ||
              pullUrl.host !== repository.host ||
              match?.[1]?.toLowerCase() !== repository.owner.toLowerCase() ||
              match[2]?.toLowerCase() !== repository.name.toLowerCase()
            )
              return yield* new WorktreeError({
                message: "Choose a pull request from this project's GitHub repository.",
              });
            yield* gitOk(
              toplevel,
              ["fetch", "--no-tags", repository.url, `refs/pull/${match[3]}/head`],
              "Couldn't fetch the pull request's revision.",
            );
            baseCommit = yield* gitOk(
              toplevel,
              ["rev-parse", "FETCH_HEAD^{commit}"],
              "Couldn't read the pull request's revision.",
            );
            base = choice.baseRef ?? repository.defaultBranch;
          }
          if (choice?.existingBranch !== undefined) {
            yield* gitOk(
              toplevel,
              ["check-ref-format", "--branch", choice.existingBranch],
              "Choose a valid existing branch.",
            );
            if (!(yield* hasBranch(toplevel, choice.existingBranch)))
              return yield* new WorktreeError({
                message: "That branch doesn't exist locally. Fetch it or choose another branch.",
              });
            const checkedOut = yield* gitOk(
              toplevel,
              ["for-each-ref", "--format=%(worktreepath)", `refs/heads/${choice.existingBranch}`],
              "Couldn't check that branch's workspace.",
            );
            if (checkedOut.trim())
              return yield* new WorktreeError({
                message: `That branch is checked out at ${checkedOut.trim()}. Reuse its existing workspace.`,
              });
            baseCommit = yield* gitOk(
              toplevel,
              ["rev-parse", "--verify", "--end-of-options", `${choice.existingBranch}^{commit}`],
              "Couldn't read the existing branch.",
            );
          }
          if (choice?.branch !== undefined) {
            yield* gitOk(
              toplevel,
              ["check-ref-format", "--branch", choice.branch],
              "That branch name isn't valid.",
            );
            if (yield* hasBranch(toplevel, choice.branch))
              return yield* new WorktreeError({
                message: "That branch already exists. Choose its workspace or another name.",
              });
          }
          // A number tells apart threads with the same title, and repositories with the same name.
          const slug = worktreeSlug(name);
          const home = path.join(options.directory, path.basename(toplevel));
          let attempt = 1;
          let picked = slug;
          while (
            planned.has(path.join(home, picked)) ||
            (yield* exists(path.join(home, picked))) ||
            (yield* hasBranch(toplevel, `${BRANCH_PREFIX}${picked}`))
          ) {
            attempt++;
            picked = `${slug}-${attempt}`;
          }
          const worktree: ThreadWorktree = {
            id: checkoutId(path.join(home, picked)),
            managed: true,
            startCommit: baseCommit.trim(),
            baseCommit: (yield* gitOk(
              toplevel,
              ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`],
              "Couldn't resolve the base branch.",
            )).trim(),
            // As the user chose it, so the saved projects list it once.
            project,
            root: path.join(home, picked),
            branch: choice?.existingBranch ?? choice?.branch ?? `${BRANCH_PREFIX}${picked}`,
            base,
            ...(choice?.pullRequestUrl ? { pullRequestUrl: choice.pullRequestUrl } : {}),
          };
          planned.add(worktree.root);
          // Git ends the prefix with a slash.
          return { worktree, cwd: prefix === "" ? worktree.root : path.resolve(worktree.root, prefix) };
        }, picking.withPermits(1)),

        checkOut: (worktree) =>
          toplevelOf(worktree.project).pipe(
            Effect.flatMap((toplevel) => checkOut(toplevel, worktree)),
            // Its folder and branch keep the name from here on, or it's free again.
            Effect.ensuring(Effect.sync(() => planned.delete(worktree.root))),
          ),

        changes,

        remove: Effect.fn("Worktrees.remove")(function* (threadId, worktree, removal) {
          // What runs in the folder holds it open on Windows.
          yield* terminals.closeThread(threadId);
          // Unknown counts as unmerged: the branch stays rather than lose commits.
          const keepBranch =
            removal?.keepBranch === true ||
            (yield* unmerged(worktree).pipe(
              Effect.map((count) => count > 0),
              Effect.orElseSucceed(() => true),
            ));
          const repo = worktree.project;
          if (yield* exists(worktree.root)) {
            // Moved aside at once and deleted behind: its dependencies alone are tens of thousands of
            // files, and `git worktree remove` takes minutes over them, follows bun's workspace links
            // on Windows, and stops at node_modules' long paths. A harness that just ended can hold a
            // file open for a moment longer.
            const aside = path.join(removing, `${path.basename(worktree.root)}-${Date.now().toString(36)}`);
            const moved = yield* fs.makeDirectory(removing, { recursive: true }).pipe(
              Effect.andThen(fs.rename(worktree.root, aside)),
              Effect.retry({ times: 3, schedule: Schedule.spaced("500 millis") }),
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            );
            if (moved) {
              yield* Effect.forkIn(clear(aside), layerScope);
            } else {
              // Something runs in it still. Without its `.git` file it's no worktree to git, which
              // forgets it below, and the folder goes behind the thread once whatever holds it ends.
              yield* fs.remove(path.join(worktree.root, ".git"), { force: true }).pipe(
                Effect.mapError(
                  () =>
                    new WorktreeError({
                      message: `Couldn't remove ${worktree.root}: something still has files open there.`,
                    }),
                ),
              );
              yield* Effect.forkIn(clearInPlace(worktree.root), layerScope);
            }
          }
          // Git forgets a worktree whose folder is gone.
          yield* git(repo, ["worktree", "prune"]);
          if (!keepBranch) yield* git(repo, ["branch", "-D", worktree.branch]);
        }),

        restore: Effect.fn("Worktrees.restore")(function* (worktree) {
          // A folder without its `.git` file is what's left of a removal still under way.
          if (yield* exists(path.join(worktree.root, ".git"))) return;
          yield* vacate(worktree.root);
          yield* checkOut(yield* toplevelOf(worktree.project), worktree);
        }),
      });
    }),
  );
