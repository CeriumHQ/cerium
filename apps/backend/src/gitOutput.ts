import type { GitOperationKind, LocalBranch, RemoteBranch, StashEntry } from "@cerium/rpc";

import { parseStatusBranch } from "./git.ts";

// How the branch tools (gitBranches.ts) read git: its complaints put in plain words, and what its
// status, branch and stash listings print, parsed. Nothing here runs git.

// ---------------------------------------------------------------------------------------------
// Git's words

/** What git printed, and how it exited. */
export interface Run {
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
  const { branch, head, detached, upstream, entries } = parseStatusBranch(output);
  const fields = entries.split("\0");
  let changes = 0;
  const unmerged: Array<{ xy: string; path: string }> = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
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
    ...(head === undefined ? {} : { commit: head.slice(0, 7) }),
    detached,
    ...(upstream === undefined ? {} : { upstream }),
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
export const insideFolder = (prefix: string, file: string): string | undefined => {
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
export const BRANCH_FORMAT = [
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
export const isRefName = (name: string) => name !== "" && !name.startsWith("-") && !/[\0\r\n]/.test(name);
