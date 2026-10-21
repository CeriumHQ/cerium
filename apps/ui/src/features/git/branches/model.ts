import type {
  GitBranchList,
  GitBranchState,
  GitOperationKind,
  LocalBranch,
  RemoteBranch,
  UnmergedFile,
} from "@cerium/rpc";

// What Source control's header shows of a repository's branch and its sync with the remote, and what
// it says while a merge or rebase waits: plain functions the controls feed with what the machine says.

/** How often the panel fetches quietly while it is open, and the least between two of them. */
export const QUIET_FETCH_EVERY_MS = 3 * 60_000;

// ---------------------------------------------------------------------------------------------
// The branch

/** What the branch control calls the checkout: the branch, or the commit when HEAD is on none. */
export const branchTitle = (state: GitBranchState): { readonly name: string; readonly detached: boolean } =>
  state.branch !== undefined
    ? { name: state.branch, detached: false }
    : { name: state.commit ?? "No commits yet", detached: state.commit !== undefined };

const hasControl = (text: string) => {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/** What git accepts as a branch's name, so the form can say so before asking: git has the last word. */
export const branchNameProblem = (name: string): string | undefined => {
  if (name === "") return "Give the branch a name.";
  if (/\s/.test(name)) return "A branch name can't have spaces.";
  if (name.startsWith("-") || name.startsWith(".") || name.startsWith("/")) {
    return "A branch name can't start with a dash, a dot or a slash.";
  }
  if (name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) {
    return "A branch name can't end with a slash, a dot or .lock.";
  }
  if (/\.\.|@\{|\/\/|[~^:?*[\\]/.test(name) || hasControl(name)) {
    return "A branch name can't hold .. @{ ~ ^ : ? * [ or a backslash.";
  }
  if (name === "@" || name === "HEAD") return "That name is git's own.";
  return undefined;
};

/** The remote branches nothing local follows, which the menu lists under Remote. */
export const unfollowedRemotes = (list: GitBranchList): ReadonlyArray<RemoteBranch> =>
  list.remote.filter((branch) => branch.local === undefined);

/** Where `needle` first occurs in `haystack`, ignoring case; `-1` when it doesn't. */
const position = (haystack: string, needle: string) => haystack.toLowerCase().indexOf(needle.toLowerCase());

/** `names`' matches for `query`, those that start with it first, then by where it occurs; all of them without one. */
const rank = <T>(items: ReadonlyArray<T>, name: (item: T) => string, query: string): ReadonlyArray<T> => {
  const needle = query.trim();
  if (needle === "") return items;
  return items
    .map((item, index) => ({ item, index, at: position(name(item), needle) }))
    .filter(({ at }) => at !== -1)
    .toSorted((a, b) => a.at - b.at || a.index - b.index)
    .map(({ item }) => item);
};

/** The branches the menu lists for what was typed: local ones, then remote ones nothing local follows. */
export const matchBranches = (
  list: GitBranchList,
  query: string,
): { readonly local: ReadonlyArray<LocalBranch>; readonly remote: ReadonlyArray<RemoteBranch> } => ({
  local: rank(list.local, (branch) => branch.name, query),
  remote: rank(unfollowedRemotes(list), (branch) => branch.name, query),
});

/** Whether `name` is a local branch already, so the menu offers no second one by that name. */
export const hasLocalBranch = (list: GitBranchList, name: string): boolean =>
  list.local.some((branch) => branch.name === name);

/** Why a branch can't be switched to from this folder, in words; undefined when it can. */
export const switchBlocked = (branch: LocalBranch): string | undefined =>
  branch.checkedOutAt === undefined
    ? undefined
    : `${branch.name} is checked out in another worktree (${branch.checkedOutAt}). Switch that one to another branch first.`;

// ---------------------------------------------------------------------------------------------
// Syncing

/** What the sync button does when pressed. */
export type SyncAction = "fetch" | "pull" | "push" | "publish";

/** The sync controls for a state: the button's action, what each menu entry may do, and the counts to show. */
export interface SyncPlan {
  /** The button is hidden: no remote to sync with, HEAD on no branch, or an operation waiting to be finished first. */
  readonly hidden: boolean;
  readonly primary: SyncAction;
  readonly ahead: number;
  readonly behind: number;
  /** The remote branch is gone: deleted, or never fetched. */
  readonly gone: boolean;
  /** The branch and its upstream each have commits the other lacks. */
  readonly diverged: boolean;
  readonly can: Readonly<Record<SyncAction | "force", boolean>>;
}

export const syncPlan = (state: GitBranchState): SyncPlan => {
  const upstream = state.upstream;
  const ahead = upstream?.ahead ?? 0;
  const behind = upstream?.behind ?? 0;
  const hasRemote = state.remotes.length > 0;
  const onBranch = state.branch !== undefined;
  const following = upstream !== undefined && !upstream.gone;
  const can = {
    fetch: hasRemote,
    pull: following,
    push: following && ahead > 0,
    publish: hasRemote && onBranch && (upstream === undefined || upstream.gone),
    force: following,
  };
  let primary: SyncAction = "fetch";
  if (!following) primary = can.publish ? "publish" : "fetch";
  else if (behind > 0) primary = "pull";
  else if (ahead > 0) primary = "push";
  return {
    hidden: !hasRemote || !onBranch || state.operation !== undefined,
    primary,
    ahead,
    behind,
    gone: upstream?.gone === true,
    diverged: ahead > 0 && behind > 0,
    can,
  };
};

/** The sync button's label. */
export const syncLabel = (plan: SyncPlan): string => {
  switch (plan.primary) {
    case "publish":
      return "Publish";
    case "pull":
      return "Pull";
    case "push":
      return "Push";
    default:
      return "Fetch";
  }
};

/** What the sync button's tooltip says about where the branch stands, in words. */
export const syncHint = (plan: SyncPlan, upstream: string | undefined): string => {
  if (plan.gone)
    return `${upstream ?? "The remote branch"} no longer exists. Publish to push this branch again.`;
  if (upstream === undefined) return "This branch isn't on the remote yet.";
  if (plan.diverged) {
    return `${upstream} has moved on: ${plan.behind} to pull, ${plan.ahead} to push. Pull first.`;
  }
  if (plan.behind > 0) return `${plan.behind} new on ${upstream}.`;
  if (plan.ahead > 0) return `${plan.ahead} not on ${upstream} yet.`;
  return `Up to date with ${upstream}.`;
};

/** How long ago the panel last fetched is shown with this; "just now" or "5 minutes ago". */
export const fetchedNote = (at: number | undefined, now: number, ago: (at: number, now: number) => string) =>
  at === undefined ? "Not fetched since the panel opened." : `Fetched ${ago(at, now)}.`;

// ---------------------------------------------------------------------------------------------
// Operations that stop halfway

/** What the banner calls an operation git stopped halfway through. */
export const operationName = (kind: GitOperationKind): string =>
  kind === "cherry-pick" ? "Cherry-pick" : kind[0]!.toUpperCase() + kind.slice(1);

/** The banner's title: the operation in progress and, for a rebase, how far it is. */
export const operationTitle = (state: GitBranchState): string => {
  const operation = state.operation;
  if (operation === undefined) return "Conflicts to resolve";
  const progress =
    operation.step !== undefined && operation.total !== undefined && operation.total > 1
      ? ` (step ${operation.step} of ${operation.total})`
      : "";
  return `${operationName(operation.kind)} in progress${progress}`;
};

/** The line under the title: what is left to do. */
export const operationNote = (state: GitBranchState): string => {
  const count = state.conflicts.length;
  if (count > 0) return count === 1 ? "1 file needs your decision." : `${count} files need your decision.`;
  return state.operation === undefined ? "" : "Every conflict is resolved. Continue to finish.";
};

/** Whether git has a step to skip for this operation: a merge has none. */
export const canSkip = (kind: GitOperationKind): boolean => kind !== "merge";

/** What Take ours and Take theirs keep, for the tooltips: the whole file, and git's two sides swap in a rebase. */
export const sideHelp = (kind: GitOperationKind | undefined, side: "ours" | "theirs"): string => {
  if (kind === "rebase") {
    return side === "ours"
      ? "Keep the whole file as it is on the branch being rebased onto."
      : "Keep the whole file as your commit has it: your own change.";
  }
  if (kind === "cherry-pick" || kind === "revert") {
    return side === "ours"
      ? "Keep the whole file as it is on the branch you're on."
      : kind === "revert"
        ? "Keep the whole file as it was before the commit being reverted."
        : "Keep the whole file as the commit being picked has it.";
  }
  return side === "ours"
    ? "Keep the whole file as it is on the branch you're on."
    : "Keep the whole file as it is on the branch being merged in.";
};

/** What a conflicted file's two sides did, in words: "Changed on both sides", "Deleted here, changed there". */
export const conflictNote = (file: UnmergedFile): string => {
  const { ours, theirs } = file;
  if (ours === "modified" && theirs === "modified") return "Changed on both sides";
  if (ours === "added" && theirs === "added") return "Added on both sides";
  if (ours === "deleted" && theirs === "deleted") return "Deleted on both sides";
  if (ours === "deleted")
    return theirs === "added" ? "Added there, deleted here" : "Deleted here, changed there";
  if (theirs === "deleted")
    return ours === "added" ? "Added here, deleted there" : "Changed here, deleted there";
  return "Changed on both sides";
};
