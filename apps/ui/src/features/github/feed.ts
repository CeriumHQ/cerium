import type {
  GitHubRepository,
  IssueFilters,
  IssueSummary,
  PullRequestFilters,
  PullRequestSummary,
} from "@cerium/rpc";

import { githubKey } from "./model.ts";

// The rail's GitHub page: the pull requests and issues of every project's repository in one list,
// newest activity first, as plain functions over what each project's folder reads.

/** Whose items the page lists. */
export type FeedScope = "open" | "mine" | "review" | "assigned";

export const feedScopes: ReadonlyArray<{ readonly scope: FeedScope; readonly label: string }> = [
  { scope: "open", label: "Everything open" },
  { scope: "mine", label: "Created by me" },
  { scope: "review", label: "Waiting on my review" },
  { scope: "assigned", label: "Assigned to me" },
];

/** What the list shows of the feed. */
export type FeedKind = "all" | "pr" | "issue";

/** What a scope asks a repository's pull requests for. */
export const pullFiltersOf = (scope: FeedScope): PullRequestFilters =>
  scope === "mine"
    ? { createdByMe: true }
    : scope === "review"
      ? { reviewRequested: true }
      : scope === "assigned"
        ? { assignedToMe: true }
        : {};

/** What a scope asks a repository's issues for; none for a review, which only pull requests wait on. */
export const issueFiltersOf = (scope: FeedScope): IssueFilters | undefined =>
  scope === "mine"
    ? { createdByMe: true }
    : scope === "review"
      ? undefined
      : scope === "assigned"
        ? { assignedToMe: true }
        : {};

/** One project's reading: its repository, and its lists once they're read. */
export interface FeedSource {
  /** The project's folder, which every call about its repository goes through. */
  readonly root: string;
  readonly repository: GitHubRepository;
  readonly pulls?: ReadonlyArray<PullRequestSummary>;
  readonly issues?: ReadonlyArray<IssueSummary>;
}

export type FeedItem =
  | { readonly kind: "pr"; readonly root: string; readonly repo: string; readonly pull: PullRequestSummary }
  | { readonly kind: "issue"; readonly root: string; readonly repo: string; readonly issue: IssueSummary };

/** A repository as GitHub names it, `owner/name`. */
export const repoName = (repository: Pick<GitHubRepository, "owner" | "name">) =>
  `${repository.owner}/${repository.name}`;

/**
 * Projects whose folders are the same repository (two clones of it) read as one: the first, the
 * project used most recently, stands for it.
 */
export const distinctRepositories = <T extends { readonly repository: GitHubRepository }>(
  sources: ReadonlyArray<T>,
): ReadonlyArray<T> => {
  const seen = new Set<string>();
  return sources.filter(({ repository }) => {
    const name = repoName(repository).toLowerCase();
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
};

const numberOf = (item: FeedItem) => (item.kind === "pr" ? item.pull.number : item.issue.number);
const titleOf = (item: FeedItem) => (item.kind === "pr" ? item.pull.title : item.issue.title);
const updatedOf = (item: FeedItem) => (item.kind === "pr" ? item.pull.updatedAt : item.issue.updatedAt);

/** Every source's pull requests and issues together, the most recently active first. */
export const feedItems = (sources: ReadonlyArray<FeedSource>): ReadonlyArray<FeedItem> =>
  distinctRepositories(sources)
    .flatMap(({ root, repository, pulls = [], issues = [] }): ReadonlyArray<FeedItem> => {
      const repo = repoName(repository);
      return [
        ...pulls.map((pull) => ({ kind: "pr" as const, root, repo, pull })),
        ...issues.map((issue) => ({ kind: "issue" as const, root, repo, issue })),
      ];
    })
    .toSorted((a, b) => updatedOf(b) - updatedOf(a));

/** The tab key an item opens under, shared with the GitHub panel's (`githubKey`). */
export const feedKey = (item: FeedItem) => githubKey(item.root, item.kind, numberOf(item));

/** Whether an item answers what was typed: words of its title, its repository, or its `#number`. */
export const matchesQuery = (item: FeedItem, query: string): boolean => {
  const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${titleOf(item)} ${item.repo} #${numberOf(item)}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
};

/** A pull request's or an issue's address on GitHub, as pasted into the search. */
export interface GitHubLink {
  readonly repo: string;
  readonly kind: "pr" | "issue";
  readonly number: number;
}

/** Reads `github.com/owner/name/pull/12` or `…/issues/12`, with or without the scheme and a trailing part. */
export const parseGitHubLink = (text: string): GitHubLink | undefined => {
  const match =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)(?:[/?#].*)?$/iu.exec(
      text.trim(),
    );
  if (match === null) return undefined;
  const [, owner = "", name = "", kind = "", number = ""] = match;
  return {
    repo: `${owner}/${name}`,
    kind: kind.toLowerCase() === "pull" ? "pr" : "issue",
    number: Number(number),
  };
};
