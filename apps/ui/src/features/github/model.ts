import type {
  ChecksState,
  ConversationItem,
  GitHubError,
  PullRequestDetail,
  PullRequestFilters,
  PullRequestSummary,
  ReviewThread,
} from "@cerium/rpc";
import { Cause } from "effect";

// What the GitHub panel and its viewers work out for themselves, as plain functions: the tabs that
// hold a pull request or an issue, the list's filters, how a pull request's state reads, and the brief
// a thread that looks into one starts from.

/** The `RPC_VERSION` that brought GitHub and pull requests; an older machine has no GitHub panel. */
export const GITHUB_VERSION = 16;

// ---------------------------------------------------------------------------------------------
// Tabs

const GITHUB_PREFIX = "github:";

/** What a GitHub tab holds. */
export type GitHubKind = "pr" | "issue";

export interface GitHubTab {
  /** The work thread's folder the panel acted on, whose repository it's in. */
  readonly root: string;
  readonly kind: GitHubKind;
  readonly number: number;
}

/** The tab key of a pull request or an issue of the repository `root` is in. */
export const githubKey = (root: string, kind: GitHubKind, number: number) =>
  `${GITHUB_PREFIX}${root}\n${kind}\n${number}`;

/** The pull request or issue a tab key names; undefined for any other key. */
export const githubOfKey = (key: string | undefined): GitHubTab | undefined => {
  if (key?.startsWith(GITHUB_PREFIX) !== true) return undefined;
  const [root = "", kind = "", number = ""] = key.slice(GITHUB_PREFIX.length).split("\n");
  const parsed = Number(number);
  if (root === "" || (kind !== "pr" && kind !== "issue") || !Number.isInteger(parsed) || parsed < 1) {
    return undefined;
  }
  return { root, kind, number: parsed };
};

/**
 * The GitHub error a read failed with, which says what to do about it; undefined when it failed some
 * other way, such as the machine going away.
 */
export const githubErrorOf = (cause: Cause.Cause<unknown>): GitHubError | undefined => {
  const error = Cause.squash(cause);
  return typeof error === "object" && error !== null && "_tag" in error && error._tag === "GitHubError"
    ? (error as GitHubError)
    : undefined;
};

/** What a failed read says to the user: GitHub's own words when it gave some. */
export const failureMessage = (cause: Cause.Cause<unknown>, fallback: string): string =>
  githubErrorOf(cause)?.message ?? fallback;

// ---------------------------------------------------------------------------------------------
// The list

/** The open pull requests, with nothing narrowing them. */
export const NO_PULL_FILTERS: PullRequestFilters = {};

/** Filters as the cache key of what they ask for: ones that ask the same give the same key. */
export const pullFiltersKey = (filters: PullRequestFilters): string => {
  const search = filters.search?.trim() ?? "";
  return JSON.stringify({
    ...(filters.state === undefined || filters.state === "open" ? {} : { state: filters.state }),
    ...(filters.createdByMe === true ? { createdByMe: true } : {}),
    ...(filters.reviewRequested === true ? { reviewRequested: true } : {}),
    ...(filters.assignedToMe === true ? { assignedToMe: true } : {}),
    ...(search === "" ? {} : { search }),
  });
};

/** The filters a key stands for. */
export const pullFiltersOfKey = (key: string): PullRequestFilters => JSON.parse(key) as PullRequestFilters;

/** How many things narrow the list besides showing the open ones, for the badge on the filter button. */
export const pullFilterCount = (filters: PullRequestFilters): number =>
  (filters.state === undefined || filters.state === "open" ? 0 : 1) +
  (filters.createdByMe === true ? 1 : 0) +
  (filters.reviewRequested === true ? 1 : 0) +
  (filters.assignedToMe === true ? 1 : 0);

// ---------------------------------------------------------------------------------------------
// States

export type PullStateKind = "open" | "draft" | "closed" | "merged";

/** A pull request's state as its badge shows it: a draft is open, but reads as a draft. */
export const pullStateOf = (pull: Pick<PullRequestSummary, "state" | "draft">): PullStateKind =>
  pull.state === "open" && pull.draft ? "draft" : pull.state;

export const pullStateLabel: Record<PullStateKind, string> = {
  open: "Open",
  draft: "Draft",
  closed: "Closed",
  merged: "Merged",
};

export const checksLabel: Record<ChecksState, string> = {
  passing: "Checks passing",
  failing: "Checks failing",
  pending: "Checks running",
};

/** A label's colour as CSS; GitHub's six hex digits, or the grey it gives labels without one. */
export const labelColor = (color: string): string => (/^[0-9a-f]{6}$/i.test(color) ? `#${color}` : "#ededed");

/** `owner/name#number`, or just `#number` in the conversation's own repository. */
export const referenceLabel = (reference: { number: number; repository?: string | undefined }): string =>
  reference.repository === undefined ? `#${reference.number}` : `${reference.repository}#${reference.number}`;

/**
 * What merging waits for, by GitHub's merge state, in words; undefined when there's nothing to say or
 * GitHub hasn't worked it out yet.
 */
export const mergeStateNote = (state: string | undefined): string | undefined => {
  switch (state) {
    case "clean":
    case "has_hooks":
      return "Ready to merge";
    case "dirty":
      return "Conflicts with the base branch must be resolved first";
    case "behind":
      return "Behind the base branch, which must be merged in first";
    case "blocked":
      return "Blocked until the required reviews and checks pass";
    case "unstable":
      return "Some checks didn't pass";
    case "draft":
      return "A draft can't be merged until it's ready for review";
    default:
      return undefined;
  }
};

/** A branch's name as a pull request's title to start from: `ada/login-loop` reads "Login loop". */
export const titleOfBranch = (branch: string): string => {
  const words = (branch.split("/").at(-1) ?? branch).replace(/[-_]+/g, " ").trim();
  return words === "" ? branch : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

// ---------------------------------------------------------------------------------------------
// The conversation

/** An entry of the conversation as the viewer shows it: commits that mention it in a row fold into one. */
export type ConversationEntry =
  | ConversationItem
  | {
      readonly _tag: "CommittedRun";
      readonly at: number;
      readonly commits: ReadonlyArray<Extract<ConversationItem, { readonly _tag: "Committed" }>>;
    };

/** The conversation with each run of commits that mention it folded into one entry. */
export const foldConversation = (
  items: ReadonlyArray<ConversationItem>,
): ReadonlyArray<ConversationEntry> => {
  const entries: Array<ConversationEntry> = [];
  for (const item of items) {
    const last = entries.at(-1);
    if (item._tag === "Committed" && (last?._tag === "Committed" || last?._tag === "CommittedRun")) {
      const commits = last._tag === "Committed" ? [last] : last.commits;
      entries[entries.length - 1] = {
        _tag: "CommittedRun",
        at: commits[0]?.at ?? item.at,
        commits: [...commits, item],
      };
    } else entries.push(item);
  }
  return entries;
};

/** Each review's threads, by the review they were written in; threads of none are left out. */
export const threadsByReview = (
  threads: ReadonlyArray<ReviewThread>,
): ReadonlyMap<string, ReadonlyArray<ReviewThread>> => {
  const byReview = new Map<string, Array<ReviewThread>>();
  for (const thread of threads) {
    if (thread.review === undefined) continue;
    byReview.set(thread.review, [...(byReview.get(thread.review) ?? []), thread]);
  }
  return byReview;
};

/** The review threads with no review entry in the conversation to show them under. */
export const looseThreads = (
  threads: ReadonlyArray<ReviewThread>,
  timeline: ReadonlyArray<ConversationItem>,
): ReadonlyArray<ReviewThread> => {
  const reviews = new Set(timeline.flatMap((item) => (item._tag === "Review" ? [item.id] : [])));
  return threads.filter((thread) => thread.review === undefined || !reviews.has(thread.review));
};

// ---------------------------------------------------------------------------------------------
// Starting a thread

/** The most of a pull request's text the brief holds, so one with a long history still starts a thread. */
const BRIEF_LIMIT = 24_000;

/** One text's share of the brief. */
const BODY_LIMIT = 4_000;

const shorten = (text: string, limit: number) =>
  text.length <= limit
    ? text
    : `${text.slice(0, limit).trimEnd()}\n… (cut: ${text.length - limit} more characters on GitHub)`;

const reviewWord: Record<string, string> = {
  approved: "approved",
  changesRequested: "changes requested",
  reviewRequired: "review required",
};

/**
 * What a thread that looks into a pull request starts from: where it is, what it changes and what
 * reviewers said, with the ask. In a worktree of its own the agent checks the pull request out first;
 * in the project's folder it reads the change without switching the user's branch.
 */
export const pullRequestBrief = (pull: PullRequestDetail, { worktree }: { worktree: boolean }): string => {
  const facts = [
    pullStateLabel[pullStateOf(pull)],
    `merges \`${pull.head}\` into \`${pull.base}\``,
    `${pull.changedFiles} files, +${pull.additions} −${pull.deletions}`,
    pull.reviewDecision === undefined ? undefined : reviewWord[pull.reviewDecision],
    pull.checks === undefined ? undefined : checksLabel[pull.checks].toLowerCase(),
    pull.labels.length === 0 ? undefined : `labels: ${pull.labels.map((label) => label.name).join(", ")}`,
  ].filter((fact) => fact !== undefined);
  const parts = [
    `Look into GitHub pull request #${pull.number}, "${pull.title}" (${pull.url}).`,
    `${facts.join("; ")}${pull.author === undefined ? "" : `. Opened by ${pull.author.login}`}.`,
    pull.body.trim() === ""
      ? "It has no description."
      : `Description:\n${shorten(pull.body.trim(), BODY_LIMIT)}`,
  ];
  let size = parts.join("\n\n").length;
  let skipped = 0;
  const fits = (entry: string) => {
    if (size + entry.length > BRIEF_LIMIT) {
      skipped++;
      return false;
    }
    size += entry.length;
    return true;
  };

  const open = pull.threads.filter((thread) => !thread.resolved);
  const threads = open.flatMap((thread) => {
    const where = `${thread.path}${thread.line === undefined ? "" : `:${thread.line}`}${thread.outdated ? " (outdated)" : ""}`;
    const said = thread.comments
      .map((comment) => `${comment.author?.login ?? "ghost"}: ${shorten(comment.body.trim(), BODY_LIMIT)}`)
      .join("\n");
    const entry = `${where}\n${said}`;
    return fits(entry) ? [entry] : [];
  });
  if (threads.length > 0) parts.push(`Unresolved review threads:\n\n${threads.join("\n\n")}`);

  const said = pull.timeline.flatMap((item) => {
    if ((item._tag !== "Comment" && item._tag !== "Review") || item.hidden !== undefined) return [];
    if (item.body.trim() === "") return [];
    const verdict =
      item._tag === "Review" && item.state === "approved"
        ? " (approved)"
        : item._tag === "Review" && item.state === "changesRequested"
          ? " (requested changes)"
          : "";
    const entry = `${item.author?.login ?? "ghost"}${verdict} wrote:\n${shorten(item.body.trim(), BODY_LIMIT)}`;
    return fits(entry) ? [entry] : [];
  });
  if (said.length > 0) parts.push(`Comments and reviews, oldest first:\n\n${said.join("\n\n")}`);
  if (skipped > 0 || pull.timelineNext !== undefined) {
    parts.push("More of the conversation is on GitHub than is quoted here.");
  }
  parts.push(
    worktree
      ? `You're in a worktree of your own: check the pull request out there first with \`gh pr checkout ${pull.number} --detach\`.`
      : `Read its change with \`gh pr diff ${pull.number}\`; don't switch this folder's branch.`,
    "Work out what it does, whether it's right, and what is left to address from the review, and tell me. Don't change anything yet.",
  );
  return parts.join("\n\n");
};
