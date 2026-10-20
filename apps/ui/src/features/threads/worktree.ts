import type { WorktreeChanges } from "@cerium/protocol";

// What the window says about a thread's own worktree when it is put away.

/** The `RPC_VERSION` that brought worktrees; an older machine runs every thread in its project's folder. */
export const WORKTREE_VERSION = 7;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What archiving a thread's worktree puts away, in two parts: what the worktree holds, and what
 * becomes of it. Uncommitted changes go with the folder; commits stay on the branch.
 */
export const archiveWarning = (
  { uncommitted, unmerged }: WorktreeChanges,
  worktree: { readonly branch: string; readonly base: string },
): { readonly holds: string; readonly outcome: string } => {
  const changes = count(uncommitted, "uncommitted change", "uncommitted changes");
  const commits = `${count(unmerged, "commit", "commits")} not merged into ${worktree.base}`;
  const kept = `${unmerged === 1 ? "the commit stays" : "the commits stay"} on ${worktree.branch}`;
  if (unmerged === 0) return { holds: changes, outcome: "Archiving removes its worktree and discards them." };
  if (uncommitted === 0) return { holds: commits, outcome: `Archiving removes its worktree; ${kept}.` };
  return {
    holds: `${changes} and ${commits}`,
    outcome: `Archiving removes its worktree and discards the changes; ${kept}.`,
  };
};
