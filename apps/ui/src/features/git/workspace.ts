import type { CheckoutInfo, SourceControlSnapshot, WorkspaceChoice } from "@cerium/protocol";

import type { PullStateKind } from "../github/model.ts";

// What the workspace controls say about a checkout: its place, its state in a few words, and the
// links pasted into it. The components stay layout; the words are decided here.

const normal = (path: string) => {
  const slashed = path.replaceAll("\\", "/").replace(/\/+$/, "");
  // A drive letter means Windows, whose paths ignore case.
  return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed;
};

export const samePath = (left: string, right: string) => normal(left) === normal(right);

/** A checkout's last folders, which tell worktrees apart without the long prefix they share. */
export const pathTail = (path: string, folders = 2) =>
  path
    .split(/[\\/]+/)
    .filter(Boolean)
    .slice(-folders)
    .join("/");

/** The checkouts a thread can work in: on a branch, matching `query` by branch or folder. */
export const checkoutsMatching = (
  checkouts: ReadonlyArray<CheckoutInfo>,
  query: string,
  except: ReadonlyArray<string> = [],
) => {
  const needle = query.trim().toLowerCase();
  return checkouts.filter(
    (checkout) =>
      !checkout.detached &&
      !except.some((path) => samePath(path, checkout.path)) &&
      (needle === "" || `${checkout.branch} ${normal(checkout.path)}`.toLowerCase().includes(needle)),
  );
};

/**
 * What a checkout's row says under its branch: its folder, unless the branch already names it (as a
 * worktree's does), then who works there. Undefined when there's nothing to add.
 */
export const checkoutDetail = (checkout: Pick<CheckoutInfo, "path" | "branch" | "threads">) => {
  const folder = pathTail(checkout.path, 1);
  const named = checkout.branch === folder || checkout.branch.endsWith(`/${folder}`);
  const parts = [named ? undefined : folder, threadsLabel(checkout.threads)].filter(
    (part) => part !== undefined,
  );
  return parts.length === 0 ? undefined : parts.join(" · ");
};

/** "2 threads", or the one thread's title when it's alone there. */
export const threadsLabel = (threads: CheckoutInfo["threads"]) => {
  const active = threads.filter((thread) => thread.active);
  if (active.length === 0) return threads.length === 0 ? undefined : "No active threads";
  return active.length === 1 ? active[0]!.title : `${active.length} threads`;
};

/** What a pasted GitHub address links, a pull request or an issue; undefined for anything else. */
export const linkKindOf = (url: string): "pull" | "issue" | undefined => {
  let pathname: string;
  try {
    pathname = new URL(url.trim()).pathname;
  } catch {
    return undefined;
  }
  if (/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(pathname)) return "pull";
  if (/^\/[^/]+\/[^/]+\/issues\/\d+\/?$/.test(pathname)) return "issue";
  return undefined;
};

/** The number in a pull request's or an issue's address. */
export const linkNumber = (url: string) => /\/(?:pull|issues)\/(\d+)/.exec(url)?.[1];

/** GitHub's state word as the GitHub views draw it. */
export const pullStateKind = (state: string): PullStateKind =>
  state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : "open";

const checksWord: Record<string, { readonly word: string; readonly tone: string }> = {
  passed: { word: "Checks pass", tone: "text-success-text" },
  failed: { word: "Checks fail", tone: "text-error-text" },
  pending: { word: "Checks running", tone: "text-attention-text" },
};

const reviewWord: Record<string, { readonly word: string; readonly tone: string }> = {
  APPROVED: { word: "Approved", tone: "text-success-text" },
  CHANGES_REQUESTED: { word: "Changes requested", tone: "text-error-text" },
  REVIEW_REQUIRED: { word: "Review required", tone: "text-fg-tertiary" },
  conflicts: { word: "Conflicts", tone: "text-error-text" },
};

/** A linked pull request's checks and review, each as a word and its tone; none for what it lacks. */
export const pullFacts = (pull: { readonly checks: string; readonly review: string }) =>
  [checksWord[pull.checks], reviewWord[pull.review]].filter((fact) => fact !== undefined);

/** The checkout's state in a few words, each a count: "3 changed", "2 to push". */
export const statusWords = (
  snapshot: Pick<SourceControlSnapshot, "staged" | "unstaged" | "conflicted" | "ahead" | "behind">,
) => {
  const changed = snapshot.staged + snapshot.unstaged;
  return [
    snapshot.conflicted > 0 ? `${snapshot.conflicted} in conflict` : undefined,
    changed > 0 ? `${changed} changed` : undefined,
    snapshot.ahead > 0 ? `${snapshot.ahead} to push` : undefined,
    snapshot.behind > 0 ? `${snapshot.behind} to pull` : undefined,
  ].filter((word) => word !== undefined);
};

/** Where a new worktree starts. */
export type WorktreeSource = "base" | "thread" | "pull" | "existing";

export interface WorktreeForm {
  readonly source: WorktreeSource;
  readonly base: string;
  /** The new branch's name; empty names it from the task. */
  readonly branch: string;
  readonly thread?: { readonly id: string; readonly branch: string } | undefined;
  readonly pullUrl: string;
  readonly existing: string;
}

/** The workspace a filled-in form asks for; undefined while it lacks what its source needs. */
export const worktreeChoice = (form: WorktreeForm): WorkspaceChoice | undefined => {
  const named = form.branch.trim() ? { branch: form.branch.trim() } : {};
  switch (form.source) {
    case "base":
      return form.base.trim() ? { baseRef: form.base.trim(), ...named } : undefined;
    case "thread":
      return form.thread
        ? { sourceThreadId: form.thread.id, baseRef: form.thread.branch, ...named }
        : undefined;
    case "pull":
      return linkKindOf(form.pullUrl) === "pull"
        ? { pullRequestUrl: form.pullUrl.trim(), ...named }
        : undefined;
    case "existing":
      return form.existing.trim() ? { existingBranch: form.existing.trim() } : undefined;
  }
};

/** The form a saved choice fills in again, from `base` where it names nothing. */
export const worktreeForm = (choice: WorkspaceChoice | undefined, base: string): WorktreeForm => ({
  source: choice?.existingBranch
    ? "existing"
    : choice?.pullRequestUrl
      ? "pull"
      : choice?.sourceThreadId
        ? "thread"
        : "base",
  base: choice?.baseRef ?? base,
  branch: choice?.branch ?? "",
  ...(choice?.sourceThreadId
    ? { thread: { id: choice.sourceThreadId, branch: choice.baseRef ?? base } }
    : {}),
  pullUrl: choice?.pullRequestUrl ?? "",
  existing: choice?.existingBranch ?? "",
});

/** The branch a chosen new worktree will be on, as far as the choice says. */
export const worktreeLabel = (choice: WorkspaceChoice | undefined) =>
  choice?.existingBranch ??
  choice?.branch ??
  (choice?.pullRequestUrl ? `PR #${linkNumber(choice.pullRequestUrl) ?? ""}` : "New worktree");
