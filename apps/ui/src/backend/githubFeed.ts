import { Option } from "effect";
import { Atom, AsyncResult } from "effect/reactivity";

import {
  distinctRepositories,
  feedItems,
  issueFiltersOf,
  pullFiltersOf,
  repoName,
  type FeedItem,
  type FeedScope,
  type FeedSource,
} from "../features/github/feed.ts";
import { pullFiltersKey } from "../features/github/model.ts";
import { filtersKey } from "../features/issues/model.ts";
import {
  githubRepositoryAtom,
  pullPageAtom,
  pullPageKey,
  refreshGitHubRepository,
  refreshPullList,
} from "./github.ts";
import { issuePageAtom, issuePageKey, refreshIssueList } from "./issues.ts";
import { savedProjectsAtom } from "./projects.ts";
import type { AtomRegistry } from "effect/reactivity";

/** What the rail's GitHub page lists, and whether any of it is still being read. */
export interface GitHubFeed {
  readonly items: ReadonlyArray<FeedItem>;
  /** Each repository the projects are, as `owner/name` in lower case, by the folder that reads it. */
  readonly roots: ReadonlyMap<string, string>;
  readonly loading: boolean;
}

/**
 * Every saved project's repository's pull requests and issues in `scope`, read through each project's
 * folder: the first page of each list, the GitHub panel's own reads, so either refreshes the other.
 * Keyed by the scope and whether the machine has the issue calls ("1") or not ("0"). A project
 * that isn't a GitHub repository, or that `gh` can't read, is left out.
 */
export const githubFeedAtom = Atom.family((key: string) => {
  const [scope, issuesOk] = key.split("\n") as [FeedScope, string];
  return Atom.make((get): GitHubFeed => {
    const projects = get(savedProjectsAtom);
    let loading = projects.waiting || AsyncResult.isInitial(projects);
    const sources = Option.getOrElse(AsyncResult.value(projects), () => []).flatMap(
      (project): ReadonlyArray<FeedSource> => {
        if (project.missing === true) return [];
        const root = project.path;
        const repository = get(githubRepositoryAtom(root));
        if (AsyncResult.isInitial(repository)) loading = true;
        return Option.match(AsyncResult.value(repository), {
          onNone: () => [],
          onSome: (repository) => {
            const pulls = get(
              pullPageAtom(pullPageKey(root, pullFiltersKey(pullFiltersOf(scope)), undefined)),
            );
            const issueFilters = issueFiltersOf(scope);
            const issues =
              issueFilters === undefined || issuesOk !== "1" || !repository.hasIssues
                ? undefined
                : get(issuePageAtom(issuePageKey(root, filtersKey(issueFilters), undefined)));
            if (pulls.waiting || AsyncResult.isInitial(pulls)) loading = true;
            if (issues !== undefined && (issues.waiting || AsyncResult.isInitial(issues))) loading = true;
            const pullList = Option.getOrUndefined(AsyncResult.value(pulls))?.pullRequests;
            const issueList =
              issues === undefined ? undefined : Option.getOrUndefined(AsyncResult.value(issues))?.issues;
            return [
              {
                root,
                repository,
                ...(pullList === undefined ? {} : { pulls: pullList }),
                ...(issueList === undefined ? {} : { issues: issueList }),
              },
            ];
          },
        });
      },
    );
    const roots = new Map(
      distinctRepositories(sources).map(({ root, repository }) => [repoName(repository).toLowerCase(), root]),
    );
    return { items: feedItems(sources), roots, loading };
  });
});

export const githubFeedKey = (scope: FeedScope, issues: boolean) => `${scope}\n${issues ? "1" : "0"}`;

/** Reads the projects, and every project's repository and lists, again. */
export const refreshGitHubFeed = (registry: AtomRegistry.AtomRegistry) => {
  const projects = Option.getOrElse(AsyncResult.value(registry.get(savedProjectsAtom)), () => []);
  for (const { path } of projects) {
    refreshGitHubRepository(registry, path);
    refreshPullList(registry, path);
    refreshIssueList(registry, path);
  }
  registry.refresh(savedProjectsAtom);
};
