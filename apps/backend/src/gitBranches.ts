import {
  CeriumError,
  GitBranchRpcs,
  type GitBranchList,
  type GitBranchState,
  type GitDeleteOutcome,
  type GitOperationKind,
  type GitOutcome,
  type LocalBranch,
  type OperationAction,
  type PushMode,
  type RemoteBranch,
  type ResolveSide,
  type StashEntry,
  type SwitchChanges,
  type UnmergedFile,
} from "@cerium/rpc";
import { Context, Effect, FileSystem, Layer, Path, Schema, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { Git } from "./git.ts";

// What Source control's header does to a folder's repository: which branch is checked out and how it
// stands against its upstream, switching and managing branches, syncing with the remote, the stash,
// and merges that stop on conflicts. It runs the user's own `git`, which keeps its credentials and
// asks for them through its own helper: nothing here reads a token, and `GIT_TERMINAL_PROMPT=0`
// keeps git from waiting on a terminal that isn't there.

/** A request the backend refused or git failed; `message` is written for the user. */
export class GitBranchesError extends Schema.TaggedError<GitBranchesError>()("GitBranchesError", {
  message: Schema.String,
}) {}

/** Branches listed at once, most recently committed to first. */
const MAX_LOCAL_BRANCHES = 1_000;
const MAX_REMOTE_BRANCHES = 2_000;
/** Stashes listed. */
const MAX_STASHES = 200;
/** How long git may take where it only touches the repository's own files, and where it asks a remote. */
const LOCAL_TIMEOUT = "5 minutes";
const NETWORK_TIMEOUT = "10 minutes";
/** The panel's background fetch gives up sooner: nobody is waiting on it. */
const QUIET_TIMEOUT = "2 minutes";

// ---------------------------------------------------------------------------------------------
// Git's words

/** What git printed, and how it exited. */
interface Run {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/**
 * Git's complaint in plain words, for the ones people meet most: a rejected push, a failed
 * sign-in, being offline, changes in the way. Anything else is git's own last `fatal:` or
 * `error:` line, or `fallback` when it said nothing.
 */
export const explainFailure = (output: string, fallback: string): string => {
  const text = output.replaceAll("\r", "");
  const has = (pattern: RegExp) => pattern.test(text);

  const elsewhere = /'([^']+)' is already (?:used by worktree|checked out) at '([^']+)'/i.exec(text);
  if (elsewhere) {
    return `${elsewhere[1]} is already checked out in another worktree (${elsewhere[2]}), so this folder can't switch to it. Switch that worktree to another branch first, or make a new branch from ${elsewhere[1]}.`;
  }
  if (has(/cannot delete branch '[^']+' (?:used by worktree|checked out) at/i)) {
    return "That branch is checked out, so it can't be deleted. Switch to another branch first.";
  }
  if (has(/stale info/i)) {
    return "The remote branch changed since your last fetch. Fetch, look at what's new, then push again.";
  }
  if (has(/non-fast-forward|fetch first|tip of your current branch is behind|updates were rejected/i)) {
    return "The remote has commits you don't have yet. Pull first, then push again.";
  }
  const refused = /\[remote rejected\][^\n]*\(([^)\n]+)\)/i.exec(text);
  if (refused) return `The remote refused the push: ${refused[1]}.`;
  if (has(/host key verification failed/i)) {
    return "This computer doesn't trust the remote's SSH key yet. Connect to it once from a terminal to accept it.";
  }
  if (
    has(
      /authentication failed|could not read (?:username|password)|terminal prompts disabled|permission denied \(publickey|invalid credentials|logon failed|error: 40[13]|http 40[13]|access denied|repository not found|invalid username or token/i,
    )
  ) {
    return "Git couldn't sign in to the remote. Sign in through git's credential helper (for example, run git fetch once in a terminal), then try again.";
  }
  if (
    has(
      /could not resolve host|network is unreachable|connection (?:timed out|refused|reset)|failed to connect|no route to host|temporary failure in name resolution|could not connect to server|ssl connect error|operation timed out/i,
    )
  ) {
    return "Can't reach the remote. Check your connection and try again.";
  }
  if (has(/has no upstream branch|no tracking information|no upstream configured/i)) {
    return "This branch doesn't follow a remote branch yet. Publish it first.";
  }
  if (has(/requested upstream branch '[^']*' does not exist/i)) {
    return "That remote branch doesn't exist. Fetch first, or publish this branch.";
  }
  if (has(/untracked working tree files would be (?:overwritten|removed)/i)) {
    return "Untracked files in the way would be overwritten. Move or stash them first.";
  }
  if (
    has(
      /would be overwritten by (?:checkout|merge|switch)|please commit your changes or stash them|your local changes to the following files/i,
    )
  ) {
    return "Some of your uncommitted changes would be overwritten. Commit or stash them first, or stash them as part of switching.";
  }
  if (
    has(
      /you have unstaged changes|your index contains uncommitted changes|cannot (?:pull with rebase|rebase)/i,
    )
  ) {
    return "Commit or stash your changes first.";
  }
  if (has(/refusing to merge unrelated histories/i)) {
    return "These branches have no history in common, so git won't merge them.";
  }
  if (has(/not possible to fast-forward/i)) {
    return "The branches have diverged and your git configuration only allows fast-forwards. Merge or rebase instead.";
  }
  if (
    has(
      /you have not concluded your merge|merge_head exists|you need to resolve your current index first|needs merge|unmerged files|is in progress|you are in the middle of/i,
    )
  ) {
    return "Finish or abort the merge, rebase or cherry-pick in progress first.";
  }
  const exists = /a branch named '([^']+)' already exists/i.exec(text);
  if (exists) return `A branch named ${exists[1]} already exists.`;
  if (has(/is not a valid branch name|not a valid ref/i)) return "That isn't a valid branch name.";
  if (
    has(
      /invalid reference|not a commit|unknown revision|did not match any|couldn't find remote ref|not something we can merge|invalid object name|not a valid object name/i,
    )
  ) {
    return "Git doesn't know that branch.";
  }
  if (has(/no changes - did you forget to use 'git add'|nothing to commit/i)) {
    return "This step has no changes left. Skip it instead.";
  }
  if (has(/unable to create '.*\.lock'|another git process seems to be running/i)) {
    return "Another git process is using this repository. Wait for it to finish, then try again.";
  }
  if (has(/please tell me who you are|unable to auto-detect email address|empty ident name/i)) {
    return "Git doesn't know who you are yet. Set your name and email (git config --global user.name and user.email), then try again.";
  }
  if (has(/detected dubious ownership/i)) {
    return "Git won't use this folder because it belongs to another user (its safe.directory setting).";
  }
  if (has(/not a git repository/i)) return "This folder isn't in a git repository.";
  const line = text
    .split("\n")
    .map((each) => each.trim())
    .findLast((each) => /^(?:fatal|error):/.test(each));
  return line === undefined ? fallback : line.replace(/^(?:fatal|error):\s*/, "");
};

/** Whether what git printed says there was nothing to do. */
export const saysUnchanged = (output: string): boolean =>
  /already up[ -]to[ -]date|everything up-to-date|no local changes to save/i.test(output);

/** Names of the operations, for what the user is asked to finish. */
export const operationLabel = (kind: GitOperationKind): string => kind;

// ---------------------------------------------------------------------------------------------
// Git's output

/** What `git status --porcelain=v2 -z --branch` says: the branch, how it stands, and what is changed. */
export interface ParsedStatus {
  readonly branch?: string;
  readonly commit?: string;
  readonly detached: boolean;
  readonly upstream?: {
    readonly name: string;
    readonly ahead: number;
    readonly behind: number;
    readonly gone: boolean;
  };
  readonly changes: number;
  /** Unmerged files, as git's two letters and the path from the repository's top. */
  readonly unmerged: ReadonlyArray<{ readonly xy: string; readonly path: string }>;
}

/** Everything after the `skip`th space of `field`. */
const afterSpaces = (field: string, skip: number): string => {
  let from = 0;
  for (let seen = 0; seen < skip; seen++) {
    const next = field.indexOf(" ", from);
    if (next === -1) return "";
    from = next + 1;
  }
  return field.slice(from);
};

export const parseGitStatus = (output: string): ParsedStatus => {
  const fields = output.split("\0");
  let branch: string | undefined;
  let commit: string | undefined;
  let detached = false;
  let upstreamName: string | undefined;
  let counts: { ahead: number; behind: number } | undefined;
  let changes = 0;
  const unmerged: Array<{ xy: string; path: string }> = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    if (field === "") continue;
    if (field.startsWith("# ")) {
      const header = field.slice(2);
      if (header.startsWith("branch.oid ")) {
        const oid = header.slice("branch.oid ".length);
        if (/^[0-9a-f]{7,}$/i.test(oid)) commit = oid.slice(0, 7);
      } else if (header.startsWith("branch.head ")) {
        const head = header.slice("branch.head ".length);
        if (head === "(detached)") detached = true;
        else branch = head;
      } else if (header.startsWith("branch.upstream ")) {
        upstreamName = header.slice("branch.upstream ".length);
      } else if (header.startsWith("branch.ab ")) {
        const match = /^\+(\d+) -(\d+)$/.exec(header.slice("branch.ab ".length));
        if (match) counts = { ahead: Number(match[1]), behind: Number(match[2]) };
      }
      continue;
    }
    const kind = field[0];
    if (kind === "1") changes++;
    else if (kind === "2") {
      changes++;
      // A rename or copy lists where it came from in the next field.
      index++;
    } else if (kind === "?") changes++;
    else if (kind === "u") {
      changes++;
      unmerged.push({ xy: field.slice(2, 4), path: afterSpaces(field, 10) });
    }
  }
  return {
    ...(branch === undefined ? {} : { branch }),
    ...(commit === undefined ? {} : { commit }),
    detached,
    ...(upstreamName === undefined
      ? {}
      : {
          upstream: {
            name: upstreamName,
            ahead: counts?.ahead ?? 0,
            behind: counts?.behind ?? 0,
            gone: counts === undefined,
          },
        }),
    changes,
    unmerged,
  };
};

type ConflictKind = "modified" | "added" | "deleted";

/** What each side of a conflict did, from the two letters git gives an unmerged file. */
export const conflictSides = (xy: string): { readonly ours: ConflictKind; readonly theirs: ConflictKind } => {
  switch (xy) {
    case "DD":
      return { ours: "deleted", theirs: "deleted" };
    case "AU":
      return { ours: "added", theirs: "deleted" };
    case "UD":
      return { ours: "modified", theirs: "deleted" };
    case "UA":
      return { ours: "deleted", theirs: "added" };
    case "DU":
      return { ours: "deleted", theirs: "modified" };
    case "AA":
      return { ours: "added", theirs: "added" };
    default:
      return { ours: "modified", theirs: "modified" };
  }
};

/**
 * A path from the repository's top as the folder `prefix` (with its trailing slash) names it; undefined
 * for a path outside that folder.
 */
const insideFolder = (prefix: string, file: string): string | undefined => {
  if (prefix === "") return file;
  return file.startsWith(prefix) && file.length > prefix.length ? file.slice(prefix.length) : undefined;
};

/** The distance `%(upstream:track)` describes, or undefined for a branch that follows nothing. */
export const parseTrack = (
  upstream: string,
  track: string,
): { name: string; ahead: number; behind: number; gone: boolean } | undefined => {
  if (upstream === "") return undefined;
  return {
    name: upstream,
    ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
    gone: /gone/.test(track),
  };
};

/** The `for-each-ref` format `parseBranches` reads. */
const BRANCH_FORMAT = [
  "%(refname)",
  "%(HEAD)",
  "%(upstream:short)",
  "%(upstream:track)",
  "%(worktreepath)",
  "%(committerdate:unix)",
  "%(contents:subject)",
].join("%00");

/** The branches `git for-each-ref --format=BRANCH_FORMAT` lists; `remotes` names the remotes, for splitting `origin/feature`. */
export const parseBranches = (
  output: string,
  remotes: ReadonlyArray<string>,
): { local: Array<LocalBranch>; remote: Array<RemoteBranch> } => {
  const local: Array<LocalBranch> = [];
  const remote: Array<RemoteBranch> = [];
  // The longest name first, so a remote called `team` doesn't take `team/a`'s branches.
  const names = remotes.toSorted((a, b) => b.length - a.length);
  for (const line of output.split("\n")) {
    const [ref = "", head = "", upstream = "", track = "", worktree = "", date = "", subject = ""] = line
      .replace(/\r$/, "")
      .split("\0");
    const committedAt = Number(date) || 0;
    if (ref.startsWith("refs/heads/")) {
      const name = ref.slice("refs/heads/".length);
      const current = head === "*";
      const follows = parseTrack(upstream, track);
      local.push({
        name,
        current,
        ...(follows === undefined ? {} : { upstream: follows }),
        ...(!current && worktree !== "" ? { checkedOutAt: worktree } : {}),
        committedAt,
        subject,
      });
    } else if (ref.startsWith("refs/remotes/")) {
      const name = ref.slice("refs/remotes/".length);
      // The remote's own HEAD is a pointer, not a branch.
      if (name.endsWith("/HEAD")) continue;
      const owner = names.find((each) => name.startsWith(`${each}/`)) ?? name.split("/")[0]!;
      remote.push({ name, remote: owner, committedAt, subject });
    }
  }
  // Which local branch follows each remote one; the first listed, when several do.
  const followers = new Map<string, string>();
  for (const each of local) {
    if (each.upstream !== undefined && !followers.has(each.upstream.name))
      followers.set(each.upstream.name, each.name);
  }
  return {
    local,
    remote: remote.map((branch) => {
      const follower = followers.get(branch.name);
      return follower === undefined ? branch : { ...branch, local: follower };
    }),
  };
};

/** The stashes `git stash list --format=%H%x00%gs%x00%ct` lists. */
export const parseStashes = (output: string): Array<StashEntry> => {
  const entries: Array<StashEntry> = [];
  for (const line of output.split("\n")) {
    const [commit = "", subject = "", date = ""] = line.replace(/\r$/, "").split("\0");
    if (commit === "") continue;
    // "On main: what the user wrote", or "WIP on main: 1a2b3c4 the commit's first line".
    const parsed = /^(WIP on|On) ([^:]+): (.*)$/.exec(subject);
    const branch = parsed?.[2];
    const text =
      parsed === null
        ? subject
        : parsed[1] === "WIP on"
          ? parsed[3]!.replace(/^[0-9a-f]{7,} /, "")
          : parsed[3]!;
    entries.push({
      commit,
      message: text,
      ...(branch === undefined || branch === "(no branch)" ? {} : { branch }),
      at: Number(date) || 0,
    });
  }
  return entries;
};

/** Refs the user names go to git as arguments, never as options. */
const isRefName = (name: string) => name !== "" && !name.startsWith("-") && !/[\0\r\n]/.test(name);

// ---------------------------------------------------------------------------------------------

/** Where a folder sits in a repository. */
interface Repository {
  readonly base: string;
  /** The repository's top folder, which the paths this service is given are relative to. */
  readonly top: string;
  /** The folder's path from the repository's top, with a trailing slash. */
  readonly prefix: string;
  /** This worktree's own git folder, where an unfinished operation leaves its files. */
  readonly gitDir: string;
}

export class GitBranches extends Context.Service<
  GitBranches,
  {
    state(root: string): Effect.Effect<GitBranchState, GitBranchesError>;
    branches(root: string): Effect.Effect<GitBranchList, GitBranchesError>;
    switchTo(
      root: string,
      branch: string,
      changes?: SwitchChanges,
    ): Effect.Effect<GitOutcome, GitBranchesError>;
    createBranch(
      root: string,
      name: string,
      options?: { readonly from?: string; readonly switch?: boolean; readonly changes?: SwitchChanges },
    ): Effect.Effect<GitOutcome, GitBranchesError>;
    renameBranch(root: string, branch: string, name: string): Effect.Effect<void, GitBranchesError>;
    deleteBranch(
      root: string,
      branch: string,
      force?: boolean,
    ): Effect.Effect<GitDeleteOutcome, GitBranchesError>;
    setUpstream(root: string, branch: string, upstream?: string): Effect.Effect<void, GitBranchesError>;
    fetch(root: string, quiet?: boolean): Effect.Effect<GitOutcome, GitBranchesError>;
    pull(root: string): Effect.Effect<GitOutcome, GitBranchesError>;
    push(root: string, mode?: PushMode, remote?: string): Effect.Effect<GitOutcome, GitBranchesError>;
    stashes(root: string): Effect.Effect<ReadonlyArray<StashEntry>, GitBranchesError>;
    stash(
      root: string,
      options?: { readonly message?: string; readonly includeUntracked?: boolean },
    ): Effect.Effect<GitOutcome, GitBranchesError>;
    stashApply(root: string, commit: string, pop?: boolean): Effect.Effect<GitOutcome, GitBranchesError>;
    stashDrop(root: string, commit: string): Effect.Effect<void, GitBranchesError>;
    merge(root: string, branch: string): Effect.Effect<GitOutcome, GitBranchesError>;
    operation(root: string, action: OperationAction): Effect.Effect<GitOutcome, GitBranchesError>;
    resolve(root: string, path: string, side: ResolveSide): Effect.Effect<void, GitBranchesError>;
  }
>()("cerium/backend/GitBranches") {
  /** Requires `FileSystem`, `Path`, `ChildProcessSpawner` and `Git`. */
  static readonly layer = Layer.effect(
    GitBranches,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const git = yield* Git;

      const refuse = (message: string) => new GitBranchesError({ message });
      const fail = (message: string) => Effect.fail(refuse(message));

      /** One operation at a time changes a repository: git's own lock files would turn the second one away. */
      const locks = new Map<string, Semaphore.Semaphore>();
      const lockOf = (root: string) => {
        const key = path.resolve(root);
        let lock = locks.get(key);
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1);
          locks.set(key, lock);
        }
        return lock;
      };
      const exclusive = <A, E, R>(root: string, effect: Effect.Effect<A, E, R>) =>
        lockOf(root).withPermits(1)(effect);

      /** Runs git in `cwd` and says what it printed and how it exited. */
      const run = (
        cwd: string,
        args: ReadonlyArray<string>,
        options: {
          readonly env?: Record<string, string>;
          readonly timeout?: "5 minutes" | "10 minutes" | "2 minutes";
        } = {},
      ) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make("git", [...args], {
                cwd,
                env: {
                  GIT_TERMINAL_PROMPT: "0",
                  // A merge or rebase that goes on takes the message it already has.
                  GIT_EDITOR: "true",
                  GIT_SEQUENCE_EDITOR: "true",
                  // Git's complaints are matched in English.
                  LC_ALL: "C",
                  ...options.env,
                },
                extendEnv: true,
                stdin: "ignore",
              }),
            );
            const [stdout, stderr] = yield* Effect.all(
              [
                Stream.mkString(Stream.decodeText(handle.stdout)),
                Stream.mkString(Stream.decodeText(handle.stderr)),
              ],
              { concurrency: 2 },
            );
            return { stdout, stderr, code: Number(yield* handle.exitCode) } satisfies Run;
          }),
        ).pipe(
          Effect.mapError(() => refuse("Cerium couldn't run git. Is it installed and on the PATH?")),
          Effect.timeoutOrElse({
            duration: options.timeout ?? LOCAL_TIMEOUT,
            orElse: () => fail("Git took too long to answer, so Cerium stopped it."),
          }),
        );

      /** Runs git and fails with its complaint, in plain words, when it exits with an error. */
      const runOk = (
        cwd: string,
        args: ReadonlyArray<string>,
        fallback: string,
        options?: Parameters<typeof run>[2],
      ) =>
        run(cwd, args, options).pipe(
          Effect.flatMap((result) =>
            result.code === 0
              ? Effect.succeed(result)
              : fail(explainFailure(`${result.stderr}\n${result.stdout}`, fallback)),
          ),
        );

      /** Where `root` sits in a repository, or undefined outside one. */
      const locate = Effect.fn("GitBranches.locate")(function* (root: string) {
        const base = path.resolve(root);
        const info = yield* fs.stat(base).pipe(Effect.mapError(() => refuse("That folder is gone.")));
        if (info.type !== "Directory") return yield* fail("That isn't a folder.");
        // Where git lately said a repository is, as the rest of Source control remembers it, spares
        // a git for every read the panel makes.
        const known = yield* git.repository(base);
        if (known !== undefined) {
          const { top, prefix, gitDir } = known;
          return { base, top, prefix, gitDir } satisfies Repository;
        }
        // Outside one git is asked afresh, so a repository made since shows at once and a folder git
        // refuses says why.
        const result = yield* run(base, [
          "--no-optional-locks",
          "rev-parse",
          "--is-inside-work-tree",
          "--show-prefix",
          "--absolute-git-dir",
          "--show-toplevel",
        ]);
        if (result.code !== 0) {
          if (/dubious ownership/i.test(result.stderr)) {
            return yield* fail(explainFailure(result.stderr, "Git won't use this folder."));
          }
          return undefined;
        }
        const [inside, prefix = "", gitDir = "", top = ""] = result.stdout
          .split("\n")
          .map((line) => line.replace(/\r$/, ""));
        if (inside !== "true" || gitDir === "" || top === "") return undefined;
        // A repository made since git was last asked is news to the rest of Source control too.
        yield* git.forget(base);
        return { base, top: path.resolve(top), prefix, gitDir } satisfies Repository;
      });

      const requireRepository = Effect.fn("GitBranches.requireRepository")(function* (root: string) {
        const repository = yield* locate(root);
        if (repository === undefined) return yield* fail("This folder isn't in a git repository.");
        return repository;
      });

      const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));

      const readNumber = (file: string) =>
        fs.readFileString(file).pipe(
          Effect.map((text) => Number(text.trim())),
          Effect.map((value) => (Number.isInteger(value) && value >= 0 ? value : undefined)),
          Effect.orElseSucceed(() => undefined),
        );

      /** The operation git left unfinished in `gitDir`, and how far it got. */
      const readOperation = Effect.fn("GitBranches.readOperation")(function* (gitDir: string) {
        const at = (name: string) => path.join(gitDir, name);
        if (yield* exists(at("rebase-merge"))) {
          const [step, total] = yield* Effect.all([
            readNumber(path.join(at("rebase-merge"), "msgnum")),
            readNumber(path.join(at("rebase-merge"), "end")),
          ]);
          return {
            kind: "rebase" as const,
            ...(step === undefined || total === undefined ? {} : { step, total }),
          };
        }
        if (
          (yield* exists(at("rebase-apply"))) &&
          !(yield* exists(path.join(at("rebase-apply"), "applying")))
        ) {
          const [step, total] = yield* Effect.all([
            readNumber(path.join(at("rebase-apply"), "next")),
            readNumber(path.join(at("rebase-apply"), "last")),
          ]);
          return {
            kind: "rebase" as const,
            ...(step === undefined || total === undefined ? {} : { step, total }),
          };
        }
        if (yield* exists(at("MERGE_HEAD"))) return { kind: "merge" as const };
        if (yield* exists(at("CHERRY_PICK_HEAD"))) return { kind: "cherry-pick" as const };
        if (yield* exists(at("REVERT_HEAD"))) return { kind: "revert" as const };
        // Several commits picked or reverted at once leave their list behind between stops.
        const todo = yield* fs
          .readFileString(path.join(at("sequencer"), "todo"))
          .pipe(Effect.orElseSucceed(() => ""));
        const first = todo
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line !== "" && !line.startsWith("#"));
        if (first !== undefined) {
          return { kind: /^(?:revert|r)\b/.test(first) ? ("revert" as const) : ("cherry-pick" as const) };
        }
        return undefined;
      });

      const remoteNames = (root: string) =>
        run(root, ["--no-optional-locks", "remote"]).pipe(
          Effect.map(({ stdout, code }) =>
            code === 0
              ? stdout
                  .split("\n")
                  .map((line) => line.trim())
                  .filter((line) => line !== "")
              : [],
          ),
        );

      const outside: GitBranchState = { repository: false, remotes: [], changes: 0, conflicts: [] };

      const stateAt = Effect.fn("GitBranches.stateAt")(function* (repository: Repository) {
        const [status, remotes, operation] = yield* Effect.all(
          [
            runOk(
              repository.base,
              [
                "--no-optional-locks",
                "status",
                "--porcelain=v2",
                "-z",
                "--branch",
                "--untracked-files=normal",
              ],
              "Git couldn't say where this repository stands.",
            ),
            remoteNames(repository.base),
            readOperation(repository.gitDir),
          ],
          { concurrency: 3 },
        );
        const parsed = parseGitStatus(status.stdout);
        const conflicts: Array<UnmergedFile> = parsed.unmerged.map(({ xy, path: file }) => {
          const inFolder = insideFolder(repository.prefix, file);
          return { path: file, ...(inFolder === undefined ? {} : { inFolder }), ...conflictSides(xy) };
        });
        const inside: GitBranchState = {
          repository: true,
          ...(parsed.branch === undefined ? {} : { branch: parsed.branch }),
          ...(parsed.commit === undefined ? {} : { commit: parsed.commit }),
          ...(parsed.detached ? { detached: true } : {}),
          ...(parsed.upstream === undefined ? {} : { upstream: parsed.upstream }),
          remotes,
          changes: parsed.changes,
          ...(operation === undefined ? {} : { operation }),
          conflicts,
        };
        return inside;
      });

      const state = Effect.fn("GitBranches.state")(function* (root: string) {
        const repository = yield* locate(root);
        return repository === undefined ? outside : yield* stateAt(repository);
      });

      /** Refuses to start something new while a merge, rebase or cherry-pick waits, or conflicts do. */
      const requireIdle = Effect.fn("GitBranches.requireIdle")(function* (repository: Repository) {
        const current = yield* stateAt(repository);
        if (current.operation !== undefined) {
          return yield* fail(
            `Finish or abort the ${operationLabel(current.operation.kind)} in progress first.`,
          );
        }
        if (current.conflicts.length > 0) return yield* fail("Resolve the conflicted files first.");
        return current;
      });

      /**
       * What an operation that may stop on conflicts amounted to: done, nothing to do, or stopped
       * with conflicts for the user to settle. Anything else git complained about is the user's error.
       */
      const settle = Effect.fn("GitBranches.settle")(function* (
        repository: Repository,
        result: Run,
        fallback: string,
      ) {
        if (result.code === 0) {
          return saysUnchanged(`${result.stdout}\n${result.stderr}`)
            ? ({ unchanged: true } as GitOutcome)
            : {};
        }
        const current = yield* stateAt(repository).pipe(Effect.orElseSucceed(() => undefined));
        if (current !== undefined && (current.operation !== undefined || current.conflicts.length > 0)) {
          return { conflicted: true } as GitOutcome;
        }
        return yield* fail(explainFailure(`${result.stderr}\n${result.stdout}`, fallback));
      });

      // -------------------------------------------------------------------------------------
      // Branches

      const branches = Effect.fn("GitBranches.branches")(function* (root: string) {
        const repository = yield* requireRepository(root);
        const [remotes, listed] = yield* Effect.all(
          [
            remoteNames(repository.base),
            runOk(
              repository.base,
              [
                "--no-optional-locks",
                "for-each-ref",
                "--sort=-committerdate",
                `--format=${BRANCH_FORMAT}`,
                "refs/heads",
                "refs/remotes",
              ],
              "Git couldn't list the branches.",
            ),
          ],
          { concurrency: 2 },
        );
        const { local, remote } = parseBranches(listed.stdout, remotes);
        const truncated = local.length > MAX_LOCAL_BRANCHES || remote.length > MAX_REMOTE_BRANCHES;
        return {
          local: local.slice(0, MAX_LOCAL_BRANCHES),
          remote: remote.slice(0, MAX_REMOTE_BRANCHES),
          ...(truncated ? { truncated: true as const } : {}),
        } satisfies GitBranchList;
      });

      /** The folder of another worktree that has `branch` checked out, when one does. */
      const checkedOutElsewhere = Effect.fn("GitBranches.checkedOutElsewhere")(function* (
        cwd: string,
        branch: string,
      ) {
        const result = yield* run(cwd, [
          "--no-optional-locks",
          "for-each-ref",
          "--format=%(HEAD)%00%(worktreepath)",
          `refs/heads/${branch}`,
        ]);
        if (result.code !== 0) return undefined;
        const [head = "", worktree = ""] = result.stdout.trim().split("\0");
        return head !== "*" && worktree !== "" ? worktree : undefined;
      });

      /**
       * Runs `action` (something that changes the branch checked out) with the uncommitted changes
       * stashed first when asked, and put back if the action fails.
       */
      const withChanges = Effect.fn("GitBranches.withChanges")(function* (
        cwd: string,
        changes: SwitchChanges,
        message: string,
        action: Effect.Effect<Run, GitBranchesError>,
      ) {
        let stashed = false;
        if (changes === "stash") {
          const saved = yield* runOk(
            cwd,
            ["stash", "push", "--include-untracked", "--message", message],
            "Git couldn't stash your changes.",
          );
          stashed = !/no local changes to save/i.test(`${saved.stdout}${saved.stderr}`);
        }
        const result = yield* action;
        if (result.code !== 0 && stashed) {
          // The switch didn't happen: the changes go back where they were.
          yield* run(cwd, ["stash", "pop"]).pipe(Effect.ignore);
        }
        return result;
      });

      const switchTo = Effect.fn("GitBranches.switchTo")(function* (
        root: string,
        branch: string,
        changes: SwitchChanges = "carry",
      ) {
        if (!isRefName(branch)) return yield* fail("That isn't a valid branch name.");
        return yield* exclusive(
          root,
          Effect.gen(function* () {
            const repository = yield* requireRepository(root);
            yield* requireIdle(repository);
            const elsewhere = yield* checkedOutElsewhere(repository.base, branch);
            if (elsewhere !== undefined) {
              return yield* fail(
                explainFailure(`fatal: '${branch}' is already checked out at '${elsewhere}'`, ""),
              );
            }
            const local = yield* run(repository.base, [
              "show-ref",
              "--verify",
              "--quiet",
              `refs/heads/${branch}`,
            ]);
            const remote = yield* run(repository.base, [
              "show-ref",
              "--verify",
              "--quiet",
              `refs/remotes/${branch}`,
            ]);
            // `origin/feature` becomes a local `feature` that follows it; a local name is just switched to.
            const args =
              local.code !== 0 && remote.code === 0 ? ["switch", "--track", branch] : ["switch", branch];
            const result = yield* withChanges(
              repository.base,
              changes,
              `Cerium: before switching to ${branch}`,
              run(repository.base, args),
            );
            if (result.code !== 0) {
              return yield* fail(
                explainFailure(`${result.stderr}\n${result.stdout}`, `Git couldn't switch to ${branch}.`),
              );
            }
            return {} as GitOutcome;
          }),
        );
      });

      const createBranch = Effect.fn("GitBranches.createBranch")(function* (
        root: string,
        name: string,
        options: { readonly from?: string; readonly switch?: boolean; readonly changes?: SwitchChanges } = {},
      ) {
        if (!isRefName(name)) return yield* fail("That isn't a valid branch name.");
        if (options.from !== undefined && !isRefName(options.from))
          return yield* fail("Git doesn't know that branch.");
        return yield* exclusive(
          root,
          Effect.gen(function* () {
            const repository = yield* requireRepository(root);
            const start = options.from === undefined ? [] : [options.from];
            // A branch made from `origin/main` follows nothing: publishing it makes it follow its own.
            if (options.switch === false) {
              yield* runOk(
                repository.base,
                ["branch", "--no-track", name, ...start],
                `Git couldn't make ${name}.`,
              );
              return {} as GitOutcome;
            }
            yield* requireIdle(repository);
            const result = yield* withChanges(
              repository.base,
              options.changes ?? "carry",
              `Cerium: before switching to ${name}`,
              run(repository.base, ["switch", "--create", name, "--no-track", ...start]),
            );
            if (result.code !== 0) {
              return yield* fail(
                explainFailure(`${result.stderr}\n${result.stdout}`, `Git couldn't make ${name}.`),
              );
            }
            return {} as GitOutcome;
          }),
        );
      });

      const renameBranch = Effect.fn("GitBranches.renameBranch")(function* (
        root: string,
        branch: string,
        name: string,
      ) {
        if (!isRefName(branch) || !isRefName(name)) return yield* fail("That isn't a valid branch name.");
        yield* exclusive(
          root,
          Effect.gen(function* () {
            const repository = yield* requireRepository(root);
            yield* runOk(
              repository.base,
              ["branch", "--move", branch, name],
              `Git couldn't rename ${branch}.`,
            );
          }),
        );
      });

      const deleteBranch = Effect.fn("GitBranches.deleteBranch")(function* (
        root: string,
        branch: string,
        force: boolean = false,
      ) {
        if (!isRefName(branch)) return yield* fail("That isn't a valid branch name.");
        return yield* exclusive(
          root,
          Effect.gen(function* () {
            const repository = yield* requireRepository(root);
            const result = yield* run(repository.base, ["branch", force ? "-D" : "-d", branch]);
            if (result.code === 0) return { _tag: "Deleted" } as GitDeleteOutcome;
            if (!force && /not fully merged/i.test(result.stderr)) {
              const ahead = yield* run(repository.base, [
                "rev-list",
                "--count",
                `HEAD..refs/heads/${branch}`,
              ]);
              const commits = Number(ahead.stdout.trim()) || 0;
              return { _tag: "Unmerged", commits: Math.max(1, commits) } as GitDeleteOutcome;
            }
            return yield* fail(
              explainFailure(`${result.stderr}\n${result.stdout}`, `Git couldn't delete ${branch}.`),
            );
          }),
        );
      });

      const setUpstream = Effect.fn("GitBranches.setUpstream")(function* (
        root: string,
        branch: string,
        upstream?: string,
      ) {
        if (!isRefName(branch) || (upstream !== undefined && !isRefName(upstream))) {
          return yield* fail("That isn't a valid branch name.");
        }
        yield* exclusive(
          root,
          Effect.gen(function* () {
            const repository = yield* requireRepository(root);
            yield* runOk(
              repository.base,
              upstream === undefined
                ? ["branch", "--unset-upstream", branch]
                : ["branch", `--set-upstream-to=${upstream}`, branch],
              `Git couldn't change what ${branch} follows.`,
            );
          }),
        );
      });

      // -------------------------------------------------------------------------------------
      // Syncing

      /** Every remote-tracking branch and where it points: what a fetch changes. */
      const remoteRefs = (cwd: string) =>
        run(cwd, [
          "--no-optional-locks",
          "for-each-ref",
          "--format=%(refname) %(objectname)",
          "refs/remotes",
        ]).pipe(Effect.map(({ stdout }) => stdout));

      const fetch = Effect.fn("GitBranches.fetch")(function* (root: string, quiet: boolean = false) {
        const repository = yield* requireRepository(root);
        const remotes = yield* remoteNames(repository.base);
        if (remotes.length === 0) {
          return quiet
            ? ({ unchanged: true } as GitOutcome)
            : yield* fail("This repository has no remote to fetch from.");
        }
        const work = Effect.gen(function* () {
          const before = yield* remoteRefs(repository.base);
          // Whoever isn't looking never gets a sign-in window.
          yield* runOk(repository.base, ["fetch", "--all", "--prune"], "Git couldn't fetch.", {
            timeout: quiet ? QUIET_TIMEOUT : NETWORK_TIMEOUT,
            ...(quiet ? { env: { GCM_INTERACTIVE: "never", SSH_ASKPASS_REQUIRE: "never" } } : {}),
          });
          const after = yield* remoteRefs(repository.base);
          return (before === after ? { unchanged: true } : {}) as GitOutcome;
        });
        if (!quiet) return yield* exclusive(root, work);
        // A background fetch steps aside for whatever the user is doing.
        const done = yield* lockOf(root).withPermitsIfAvailable(1)(work);
        return done._tag === "Some" ? done.value : ({ unchanged: true } as GitOutcome);
      });

      /** Whether the user's git configuration says how `branch` is pulled: merge, rebase or fast-forward only. */
      const pullConfigured = Effect.fn("GitBranches.pullConfigured")(function* (
        cwd: string,
        branch?: string,
      ) {
        const keys = ["pull.rebase", "pull.ff", ...(branch === undefined ? [] : [`branch.${branch}.rebase`])];
        const found = yield* Effect.forEach(keys, (key) => run(cwd, ["config", "--get", key]), {
          concurrency: keys.length,
        });
        return found.some(({ code }) => code === 0);
      });

      const pull = Effect.fn("GitBranches.pull")(function* (root: string) {
        return yield* exclusive(
          root,
          Effect.gen(function* () {
            const repository = yield* requireRepository(root);
            const current = yield* requireIdle(repository);
            if (current.detached === true) return yield* fail("Switch to a branch before pulling.");
            if (current.upstream === undefined) {
              return yield* fail("This branch doesn't follow a remote branch yet. Publish it first.");
            }
            // Without a preference of the user's, diverged branches are merged, as git always did.
            const configured = yield* pullConfigured(repository.base, current.branch);
            const result = yield* run(
              repository.base,
              ["pull", "--no-edit", ...(configured ? [] : ["--no-rebase"])],
              { timeout: NETWORK_TIMEOUT },
            );
            return yield* settle(repository, result, "Git couldn't pull.");
          }),
        );
      });

      const push = Effect.fn("GitBranches.push")(function* (
        root: string,
        mode: PushMode = "push",
        remote?: string,
      ) {
        if (remote !== undefined && !isRefName(remote)) return yield* fail("Git doesn't know that remote.");
        return yield* exclusive(
          root,
          Effect.gen(function* () {
            const repository = yield* requireRepository(root);
            const current = yield* stateAt(repository);
            if (current.detached === true) return yield* fail("Switch to a branch before pushing.");
            if (current.operation !== undefined) {
              return yield* fail(
                `Finish or abort the ${operationLabel(current.operation.kind)} in progress first.`,
              );
            }
            let args: ReadonlyArray<string>;
            if (mode === "publish") {
              const target =
                remote ??
                (current.remotes.includes("origin")
                  ? "origin"
                  : current.remotes.length === 1
                    ? current.remotes[0]
                    : undefined);
              if (target === undefined) {
                return yield* fail(
                  current.remotes.length === 0
                    ? "This repository has no remote yet. Add one from a terminal with git remote add."
                    : "Pick a remote to publish to.",
                );
              }
              args = ["push", "--set-upstream", target, "HEAD"];
            } else if (mode === "forceWithLease") {
              args = ["push", "--force-with-lease"];
            } else {
              args = ["push"];
            }
            const result = yield* run(repository.base, args, { timeout: NETWORK_TIMEOUT });
            if (result.code !== 0) {
              return yield* fail(explainFailure(`${result.stderr}\n${result.stdout}`, "Git couldn't push."));
            }
            return (
              saysUnchanged(`${result.stdout}\n${result.stderr}`) ? { unchanged: true } : {}
            ) as GitOutcome;
          }),
        );
      });

      // -------------------------------------------------------------------------------------
      // Stash

      const stashes = Effect.fn("GitBranches.stashes")(function* (root: string) {
        const repository = yield* requireRepository(root);
        const listed = yield* runOk(
          repository.base,
          ["--no-optional-locks", "stash", "list", `--max-count=${MAX_STASHES}`, "--format=%H%x00%gs%x00%ct"],
          "Git couldn't list the stashes.",
        );
        return parseStashes(listed.stdout);
      });

      /** `stash@{n}` for the stash whose commit is `commit`, which a stash made or dropped since can't move. */
      const stashRef = Effect.fn("GitBranches.stashRef")(function* (cwd: string, commit: string) {
        if (!/^[0-9a-f]{7,64}$/i.test(commit)) return yield* fail("That stash is gone.");
        const listed = yield* runOk(
          cwd,
          ["--no-optional-locks", "stash", "list", "--format=%H"],
          "Git couldn't list the stashes.",
        );
        const index = listed.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "")
          .findIndex((hash) => hash === commit || hash.startsWith(commit));
        if (index === -1) return yield* fail("That stash is gone.");
        return `stash@{${index}}`;
      });

      const stash = Effect.fn("GitBranches.stash")(function* (
        root: string,
        options: { readonly message?: string; readonly includeUntracked?: boolean } = {},
      ) {
        return yield* exclusive(
          root,
          Effect.gen(function* () {
            const repository = yield* requireRepository(root);
            yield* requireIdle(repository);
            const message = options.message?.trim();
            const result = yield* runOk(
              repository.base,
              [
                "stash",
                "push",
                ...(options.includeUntracked === true ? ["--include-untracked"] : []),
                ...(message === undefined || message === "" ? [] : ["--message", message]),
              ],
              "Git couldn't stash your changes.",
            );
            return (
              saysUnchanged(`${result.stdout}\n${result.stderr}`) ? { unchanged: true } : {}
            ) as GitOutcome;
          }),
        );
      });

      const stashApply = Effect.fn("GitBranches.stashApply")(function* (
        root: string,
        commit: string,
        pop: boolean = false,
      ) {
        return yield* exclusive(
          root,
          Effect.gen(function* () {
            const repository = yield* requireRepository(root);
            yield* requireIdle(repository);
            const ref = yield* stashRef(repository.base, commit);
            const result = yield* run(repository.base, ["stash", pop ? "pop" : "apply", ref]);
            return yield* settle(repository, result, "Git couldn't apply the stash.");
          }),
        );
      });

      const stashDrop = Effect.fn("GitBranches.stashDrop")(function* (root: string, commit: string) {
        yield* exclusive(
          root,
          Effect.gen(function* () {
            const repository = yield* requireRepository(root);
            const ref = yield* stashRef(repository.base, commit);
            yield* runOk(repository.base, ["stash", "drop", ref], "Git couldn't drop the stash.");
          }),
        );
      });

      // -------------------------------------------------------------------------------------
      // Merging and conflicts

      const merge = Effect.fn("GitBranches.merge")(function* (root: string, branch: string) {
        if (!isRefName(branch)) return yield* fail("Git doesn't know that branch.");
        return yield* exclusive(
          root,
          Effect.gen(function* () {
            const repository = yield* requireRepository(root);
            const current = yield* requireIdle(repository);
            if (current.detached === true) return yield* fail("Switch to a branch before merging.");
            const result = yield* run(repository.base, ["merge", "--no-edit", branch]);
            return yield* settle(repository, result, `Git couldn't merge ${branch}.`);
          }),
        );
      });

      const operation = Effect.fn("GitBranches.operation")(function* (root: string, action: OperationAction) {
        return yield* exclusive(
          root,
          Effect.gen(function* () {
            const repository = yield* requireRepository(root);
            const current = yield* stateAt(repository);
            if (current.operation === undefined) return yield* fail("Nothing is waiting to be continued.");
            const kind = current.operation.kind;
            if (action === "continue" && current.conflicts.length > 0) {
              return yield* fail("Resolve every conflicted file first, then continue.");
            }
            if (action === "skip" && kind === "merge") {
              return yield* fail("A merge has no step to skip. Abort it instead.");
            }
            const result = yield* run(repository.base, [kind, `--${action}`]);
            if (result.code === 0 && action === "abort") return {} as GitOutcome;
            return yield* settle(repository, result, `Git couldn't ${action} the ${kind}.`);
          }),
        );
      });

      const resolve = Effect.fn("GitBranches.resolve")(function* (
        root: string,
        file: string,
        side: ResolveSide,
      ) {
        if (file.includes("\0") || /^[\\/]/.test(file) || /^[a-z]:/i.test(file)) {
          return yield* fail("That path isn't inside the repository.");
        }
        yield* exclusive(
          root,
          Effect.gen(function* () {
            const repository = yield* requireRepository(root);
            // The path is from the repository's top, so git runs there.
            const cwd = repository.top;
            // The path is taken as written, never as pathspec magic.
            const literal = { env: { GIT_LITERAL_PATHSPECS: "1" } };
            if (side === "resolved") {
              yield* runOk(cwd, ["add", "--", file], `Git couldn't mark ${file} as resolved.`, literal);
              return;
            }
            const current = yield* stateAt(repository);
            const conflict = current.conflicts.find((each) => each.path === file);
            if (conflict === undefined) return yield* fail(`${file} has no conflict to settle.`);
            // Taking the side that deleted the file deletes it; there is no version to check out.
            if (conflict[side] === "deleted") {
              yield* runOk(
                cwd,
                ["rm", "--force", "--quiet", "--", file],
                `Git couldn't remove ${file}.`,
                literal,
              );
              return;
            }
            yield* runOk(
              cwd,
              ["checkout", `--${side}`, "--", file],
              `Git couldn't take ${side} for ${file}.`,
              literal,
            );
            yield* runOk(cwd, ["add", "--", file], `Git couldn't mark ${file} as resolved.`, literal);
          }),
        );
      });

      return GitBranches.of({
        state,
        branches,
        switchTo,
        createBranch,
        renameBranch,
        deleteBranch,
        setUpstream,
        fetch,
        pull,
        push,
        stashes,
        stash,
        stashApply,
        stashDrop,
        merge,
        operation,
        resolve,
      });
    }),
  );
}

/** What this service answers over the RPC; merged into the machine's handlers. */
export const gitBranchHandlers = (git: GitBranches["Service"]) => {
  const refuse = (error: GitBranchesError) => new CeriumError({ message: error.message });
  return GitBranchRpcs.of({
    GitBranchState: ({ root }) => git.state(root).pipe(Effect.mapError(refuse)),
    GitBranches: ({ root }) => git.branches(root).pipe(Effect.mapError(refuse)),
    GitSwitch: ({ root, branch, changes }) =>
      git.switchTo(root, branch, changes).pipe(Effect.mapError(refuse)),
    GitCreateBranch: ({ root, name, from, switch: switching, changes }) =>
      git
        .createBranch(root, name, {
          ...(from === undefined ? {} : { from }),
          ...(switching === undefined ? {} : { switch: switching }),
          ...(changes === undefined ? {} : { changes }),
        })
        .pipe(Effect.mapError(refuse)),
    GitRenameBranch: ({ root, branch, name }) =>
      git.renameBranch(root, branch, name).pipe(Effect.mapError(refuse)),
    GitDeleteBranch: ({ root, branch, force }) =>
      git.deleteBranch(root, branch, force).pipe(Effect.mapError(refuse)),
    GitSetUpstream: ({ root, branch, upstream }) =>
      git.setUpstream(root, branch, upstream).pipe(Effect.mapError(refuse)),
    GitFetch: ({ root, quiet }) => git.fetch(root, quiet).pipe(Effect.mapError(refuse)),
    GitPull: ({ root }) => git.pull(root).pipe(Effect.mapError(refuse)),
    GitPush: ({ root, mode, remote }) => git.push(root, mode, remote).pipe(Effect.mapError(refuse)),
    GitStashes: ({ root }) => git.stashes(root).pipe(Effect.mapError(refuse)),
    GitStash: ({ root, message, includeUntracked }) =>
      git
        .stash(root, {
          ...(message === undefined ? {} : { message }),
          ...(includeUntracked === undefined ? {} : { includeUntracked }),
        })
        .pipe(Effect.mapError(refuse)),
    GitStashApply: ({ root, commit, pop }) => git.stashApply(root, commit, pop).pipe(Effect.mapError(refuse)),
    GitStashDrop: ({ root, commit }) => git.stashDrop(root, commit).pipe(Effect.mapError(refuse)),
    GitMerge: ({ root, branch }) => git.merge(root, branch).pipe(Effect.mapError(refuse)),
    GitOperation: ({ root, action }) => git.operation(root, action).pipe(Effect.mapError(refuse)),
    GitResolve: ({ root, path, side }) => git.resolve(root, path, side).pipe(Effect.mapError(refuse)),
  });
};
