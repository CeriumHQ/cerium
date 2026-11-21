import {
  GitHubError,
  GitHubRpcs,
  type BranchPullRequest,
  type ChangedFile,
  type GitHubRepository,
  type PullRequestFilters,
} from "@cerium/rpc";
import { Effect } from "effect";

import type { Drafts } from "./drafts.ts";
import { parseRemotes, type GitHub } from "./github.ts";
import { json, text } from "./githubConversation.ts";
import {
  BRANCH_QUERY,
  CHECKS_QUERY,
  COMMITS_QUERY,
  DETAIL_QUERY,
  DRAFT_MUTATION,
  ID_QUERY,
  LIST_QUERY,
  READY_MUTATION,
  REPLY_MUTATION,
  RESOLVE_MUTATION,
  REVISION_QUERY,
  TIMELINE_QUERY,
  UNRESOLVE_MUTATION,
  changedFileOf,
  parseBranchPullRequest,
  parseChecks,
  parseCommits,
  parsePullRequestDetail,
  parsePullRequestPage,
  parseTimelinePage,
  pullRequestOf,
  pullRequestSearch,
  restCommentOf,
  restPullRequestOf,
  reviewCommentOf,
  revisionOf,
} from "./githubPullQueries.ts";

export {
  pullRequestSearch,
  LIST_QUERY,
  DETAIL_QUERY,
  TIMELINE_QUERY,
  REVISION_QUERY,
  COMMITS_QUERY,
  CHECKS_QUERY,
  BRANCH_QUERY,
  checksOf,
  summaryOf,
  parsePullRequestPage,
  reviewersOf,
  threadOf,
  parsePullRequestDetail,
  parseTimelinePage,
  parseCommits,
  checkOf,
  parseChecks,
  changedFileOf,
  restCommentOf,
  restPullRequestOf,
  parseBranchPullRequest,
} from "./githubPullQueries.ts";

// What the Pull requests tab and the pull request viewer need from GitHub: a repository's pull
// requests as a search a page at a time, one with its conversation, commits, checks and files, and
// the actions on it. The functions that don't run `gh` are plain, so they can be tested against real
// answers.

/** Pull requests a page of the list holds. */
const PAGE = 30;
/** Entries of a conversation a page holds. */
const TIMELINE_PAGE = 100;
/** Pages of changed files read at most: GitHub lists 3,000 files of a pull request, a hundred a page. */
const MAX_FILE_PAGES = 30;
/** Pages of changed files asked for at once, past the first. */
const FILE_PAGES_AT_ONCE = 5;

// ---------------------------------------------------------------------------------------------
// Running them

const notFound = (number: number) =>
  new GitHubError({ reason: "notFound", message: `This repository has no pull request #${number}.` });

/** Pull requests of the repository `cwd`'s remotes name, through `gh`. */
export const pullRequests = (github: GitHub["Service"]) => {
  const at = (cwd: string) => github.repository(cwd);
  const nameOf = (repository: GitHubRepository) => `${repository.owner}/${repository.name}`;
  const asked = (repository: GitHubRepository, number: number) => ({
    owner: repository.owner,
    name: repository.name,
    number,
  });

  const nodeId = Effect.fn("PullRequests.nodeId")(function* (repository: GitHubRepository, number: number) {
    const data = yield* github.graphql(repository.host, ID_QUERY, asked(repository, number));
    const id = text(pullRequestOf(data)?.["id"]);
    return id === undefined ? yield* notFound(number) : id;
  });

  /** The branch checked out in `cwd`; none when detached. */
  const branchIn = Effect.fn("PullRequests.branchIn")(function* (cwd: string) {
    const { stdout, code } = yield* github.git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = stdout.trim();
    return code !== 0 || branch === "" || branch === "HEAD" ? undefined : branch;
  });

  /** The remote that pushes to the repository's fork, or to the repository itself. */
  const pushRemote = Effect.fn("PullRequests.pushRemote")(function* (
    cwd: string,
    repository: GitHubRepository,
  ) {
    const { stdout } = yield* github.git(cwd, ["remote", "-v"]);
    const target = (repository.fork ?? nameOf(repository)).toLowerCase();
    const remotes = parseRemotes(stdout);
    const remote =
      remotes.find((each) => `${each.repository.owner}/${each.repository.name}`.toLowerCase() === target) ??
      remotes.find((each) => each.name === "origin");
    return remote?.name ?? "origin";
  });

  /** How far the branch is ahead of its upstream; undefined without one. */
  const aheadOfUpstream = Effect.fn("PullRequests.aheadOfUpstream")(function* (cwd: string) {
    const upstream = yield* github.git(cwd, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
    if (upstream.code !== 0) return undefined;
    const counted = yield* github.git(cwd, ["rev-list", "--count", "@{upstream}..HEAD"]);
    return Number(counted.stdout.trim()) || 0;
  });

  /** Pushes the branch checked out in `cwd`, setting its upstream when it has none. */
  const push = Effect.fn("PullRequests.push")(function* (
    cwd: string,
    repository: GitHubRepository,
    branch: string,
  ) {
    const ahead = yield* aheadOfUpstream(cwd);
    if (ahead === 0) return;
    const args =
      ahead === undefined
        ? ["push", "--set-upstream", yield* pushRemote(cwd, repository), `HEAD:refs/heads/${branch}`]
        : ["push"];
    const pushed = yield* github.git(cwd, args);
    if (pushed.code !== 0) {
      const said = pushed.stderr
        .split("\n")
        .map((line) => line.trim())
        .findLast((line) => /^(fatal|error|remote):/.test(line));
      return yield* new GitHubError({
        reason: "failed",
        message: `The branch couldn't be pushed${said === undefined ? "." : `: ${said.replace(/^(fatal|error|remote):\s*/, "")}`}`,
      });
    }
  });

  return {
    list: Effect.fn("PullRequests.list")(function* (
      cwd: string,
      filters: PullRequestFilters,
      after?: string,
    ) {
      const repository = yield* at(cwd);
      const data = yield* github.graphql(repository.host, LIST_QUERY, {
        q: pullRequestSearch(nameOf(repository), filters),
        first: PAGE,
        after: after ?? null,
      });
      return parsePullRequestPage(data);
    }),

    detail: Effect.fn("PullRequests.detail")(function* (cwd: string, number: number) {
      const repository = yield* at(cwd);
      const data = yield* github.graphql(repository.host, DETAIL_QUERY, {
        ...asked(repository, number),
        first: TIMELINE_PAGE,
        after: null,
      });
      return parsePullRequestDetail(data, nameOf(repository)) ?? (yield* notFound(number));
    }),

    timeline: Effect.fn("PullRequests.timeline")(function* (cwd: string, number: number, after: string) {
      const repository = yield* at(cwd);
      const data = yield* github.graphql(repository.host, TIMELINE_QUERY, {
        ...asked(repository, number),
        first: TIMELINE_PAGE,
        after,
      });
      return parseTimelinePage(data, nameOf(repository));
    }),

    changed: Effect.fn("PullRequests.changed")(function* (cwd: string, number: number, revision: string) {
      const repository = yield* at(cwd);
      const data = yield* github.graphql(repository.host, REVISION_QUERY, asked(repository, number));
      const pullRequest = pullRequestOf(data);
      if (pullRequest === undefined) return yield* notFound(number);
      const now = revisionOf(pullRequest);
      return { changed: now !== revision, revision: now };
    }),

    commits: Effect.fn("PullRequests.commits")(function* (cwd: string, number: number, after?: string) {
      const repository = yield* at(cwd);
      const data = yield* github.graphql(repository.host, COMMITS_QUERY, {
        ...asked(repository, number),
        after: after ?? null,
      });
      return parseCommits(data);
    }),

    checks: Effect.fn("PullRequests.checks")(function* (cwd: string, number: number) {
      const repository = yield* at(cwd);
      return parseChecks(yield* github.graphql(repository.host, CHECKS_QUERY, asked(repository, number)));
    }),

    files: Effect.fn("PullRequests.files")(function* (cwd: string, number: number) {
      const repository = yield* at(cwd);
      const page = (which: number) =>
        github
          .rest(
            repository.host,
            "GET",
            `repos/${nameOf(repository)}/pulls/${number}/files?per_page=100&page=${which}`,
          )
          .pipe(Effect.map((answer): ReadonlyArray<unknown> => (Array.isArray(answer) ? answer : [])));
      const files: Array<ChangedFile> = [];
      // The first page holds most pull requests' files. Past it a few pages are asked for at once,
      // rather than one after another, and the list ends at the first that isn't full.
      for (let first = 1; first <= MAX_FILE_PAGES;) {
        const count = first === 1 ? 1 : Math.min(FILE_PAGES_AT_ONCE, MAX_FILE_PAGES - first + 1);
        const pages = yield* Effect.forEach(
          Array.from({ length: count }, (_, index) => first + index),
          page,
          { concurrency: "unbounded" },
        );
        for (const listed of pages) {
          files.push(...listed.flatMap((each) => changedFileOf(each) ?? []));
          if (listed.length < 100) return { files };
        }
        first += count;
      }
      return { files, truncated: true };
    }),

    comment: Effect.fn("PullRequests.comment")(function* (cwd: string, number: number, body: string) {
      const repository = yield* at(cwd);
      const answer = yield* github.rest(
        repository.host,
        "POST",
        `repos/${nameOf(repository)}/issues/${number}/comments`,
        { body },
      );
      return (
        restCommentOf(answer) ??
        (yield* new GitHubError({
          reason: "failed",
          message: "GitHub took the comment but didn't send it back.",
        }))
      );
    }),

    reply: Effect.fn("PullRequests.reply")(function* (cwd: string, thread: string, body: string) {
      const repository = yield* at(cwd);
      const data = yield* github.graphql(repository.host, REPLY_MUTATION, { thread, body });
      const node = json(json(json(data)?.["addPullRequestReviewThreadReply"])?.["comment"]);
      return (
        (node === undefined ? undefined : reviewCommentOf(node)) ??
        (yield* new GitHubError({
          reason: "failed",
          message: "GitHub took the reply but didn't send it back.",
        }))
      );
    }),

    resolve: Effect.fn("PullRequests.resolve")(function* (cwd: string, thread: string, resolved: boolean) {
      const repository = yield* at(cwd);
      yield* github.graphql(repository.host, resolved ? RESOLVE_MUTATION : UNRESOLVE_MUTATION, { thread });
    }),

    review: Effect.fn("PullRequests.review")(function* (
      cwd: string,
      number: number,
      event: "comment" | "approve" | "requestChanges",
      body: string,
    ) {
      const repository = yield* at(cwd);
      if (event === "comment" && body.trim() === "") {
        return yield* new GitHubError({
          reason: "failed",
          message: "A comment review needs something written.",
        });
      }
      yield* github.rest(repository.host, "POST", `repos/${nameOf(repository)}/pulls/${number}/reviews`, {
        event: event === "comment" ? "COMMENT" : event === "approve" ? "APPROVE" : "REQUEST_CHANGES",
        ...(body.trim() === "" ? {} : { body }),
      });
    }),

    merge: Effect.fn("PullRequests.merge")(function* (
      cwd: string,
      number: number,
      method: "merge" | "squash" | "rebase",
      headOid: string,
      deleteBranch: boolean,
    ) {
      const repository = yield* at(cwd);
      const name = nameOf(repository);
      const pull = json(yield* github.rest(repository.host, "GET", `repos/${name}/pulls/${number}`));
      yield* github.rest(repository.host, "PUT", `repos/${name}/pulls/${number}/merge`, {
        merge_method: method,
        sha: headOid,
      });
      if (!deleteBranch) return;
      const head = json(pull?.["head"]);
      const branch = text(head?.["ref"]);
      const headRepository = text(json(head?.["repo"])?.["full_name"]);
      if (branch === undefined || headRepository === undefined) return;
      yield* github
        .rest(
          repository.host,
          "DELETE",
          `repos/${headRepository}/git/refs/heads/${encodeURIComponent(branch)}`,
        )
        .pipe(
          // GitHub may have deleted it already, as the repository asks.
          Effect.catchIf(
            (error) => error.reason === "notFound" || /Reference does not exist/i.test(error.message),
            () => Effect.void,
          ),
          Effect.mapError(
            (error) =>
              new GitHubError({
                reason: error.reason,
                message: `Merged, but the branch stayed: ${error.message}`,
              }),
          ),
        );
    }),

    setState: Effect.fn("PullRequests.setState")(function* (
      cwd: string,
      number: number,
      state: "open" | "closed",
    ) {
      const repository = yield* at(cwd);
      yield* github.rest(repository.host, "PATCH", `repos/${nameOf(repository)}/pulls/${number}`, { state });
    }),

    setDraft: Effect.fn("PullRequests.setDraft")(function* (cwd: string, number: number, draft: boolean) {
      const repository = yield* at(cwd);
      const id = yield* nodeId(repository, number);
      yield* github.graphql(repository.host, draft ? DRAFT_MUTATION : READY_MUTATION, { id });
    }),

    checkout: Effect.fn("PullRequests.checkout")(function* (cwd: string, number: number) {
      const repository = yield* at(cwd);
      yield* github.gh(cwd, [
        "pr",
        "checkout",
        String(number),
        "--repo",
        `${repository.host}/${nameOf(repository)}`,
      ]);
      return { branch: (yield* branchIn(cwd)) ?? "" };
    }),

    forBranch: Effect.fn("PullRequests.forBranch")(function* (cwd: string) {
      const repository = yield* at(cwd);
      const branch = yield* branchIn(cwd);
      if (branch === undefined) return { pushed: false } satisfies BranchPullRequest;
      const pushed = (yield* aheadOfUpstream(cwd)) !== undefined;
      const data = yield* github.graphql(repository.host, BRANCH_QUERY, {
        owner: repository.owner,
        name: repository.name,
        branch,
      });
      const owner = (repository.fork ?? nameOf(repository)).split("/")[0]!;
      return { branch, pushed, ...parseBranchPullRequest(data, owner) } satisfies BranchPullRequest;
    }),

    create: Effect.fn("PullRequests.create")(function* (
      cwd: string,
      title: string,
      body: string,
      base: string,
      draft: boolean,
    ) {
      const repository = yield* at(cwd);
      const branch = yield* branchIn(cwd);
      if (branch === undefined) {
        return yield* new GitHubError({
          reason: "failed",
          message: "Check out a branch to open a pull request from.",
        });
      }
      if (branch === base) {
        return yield* new GitHubError({
          reason: "failed",
          message: `This branch is ${base} itself. Pick another base.`,
        });
      }
      yield* push(cwd, repository, branch);
      const head = repository.fork === undefined ? branch : `${repository.fork.split("/")[0]}:${branch}`;
      const answer = yield* github.rest(repository.host, "POST", `repos/${nameOf(repository)}/pulls`, {
        title,
        body,
        head,
        base,
        draft,
      });
      return (
        restPullRequestOf(answer) ??
        (yield* new GitHubError({
          reason: "failed",
          message: "GitHub opened the pull request but didn't send it back.",
        }))
      );
    }),
  };
};

/** What the machine serves about GitHub and pull requests. */
export const githubHandlers = (github: GitHub["Service"], drafts: Drafts["Service"]) => {
  const pulls = pullRequests(github);
  return GitHubRpcs.of({
    GitHubStatus: () => github.status,
    LoginGitHub: () => github.login(),
    GitHubRepository: ({ cwd }) => github.repository(cwd),
    AddGitHubComment: ({ cwd, number, body }) => pulls.comment(cwd, number, body),
    ListPullRequests: ({ cwd, filters, after }) => pulls.list(cwd, filters, after),
    PullRequest: ({ cwd, number }) => pulls.detail(cwd, number),
    PullRequestTimeline: ({ cwd, number, after }) => pulls.timeline(cwd, number, after),
    PullRequestChanged: ({ cwd, number, revision }) => pulls.changed(cwd, number, revision),
    PullRequestCommits: ({ cwd, number, after }) => pulls.commits(cwd, number, after),
    PullRequestChecks: ({ cwd, number }) => pulls.checks(cwd, number),
    PullRequestFiles: ({ cwd, number }) => pulls.files(cwd, number),
    ReplyToReviewThread: ({ cwd, thread, body }) => pulls.reply(cwd, thread, body),
    ResolveReviewThread: ({ cwd, thread, resolved }) => pulls.resolve(cwd, thread, resolved),
    SubmitReview: ({ cwd, number, event, body }) => pulls.review(cwd, number, event, body),
    MergePullRequest: ({ cwd, number, method, headOid, deleteBranch }) =>
      pulls.merge(cwd, number, method, headOid, deleteBranch),
    SetPullRequestState: ({ cwd, number, state }) => pulls.setState(cwd, number, state),
    SetPullRequestDraft: ({ cwd, number, draft }) => pulls.setDraft(cwd, number, draft),
    CheckoutPullRequest: ({ cwd, number }) => pulls.checkout(cwd, number),
    BranchPullRequest: ({ cwd }) => pulls.forBranch(cwd),
    CreatePullRequest: ({ cwd, title, body, base, draft }) => pulls.create(cwd, title, body, base, draft),
    DraftPullRequest: ({ cwd, base, title, body }) => drafts.pullRequest(cwd, base, { title, body }),
  });
};
