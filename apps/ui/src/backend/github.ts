import { Effect, Stream } from "effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { pullFiltersOfKey } from "../features/github/model.ts";
import { Backend, connectionAtom } from "./client.ts";

// The GitHub panel's and the pull request viewer's reads, through the machine that runs the thread
// and the user's own `gh` there. Each read is an atom keyed by the folder (`cwd`, the work thread's)
// and what it asks for, and starts over when its version atom counts up: an action of the user's, the
// window coming back to the front, or a poll that saw the pull request change.

const key = (...parts: ReadonlyArray<string>) => parts.join("\n");

// ---------------------------------------------------------------------------------------------
// The GitHub CLI and the repository

/** The GitHub CLI on the driven machine, and who it's signed in as. */
export const githubStatusAtom = Backend.runtime
  .atom((get) => {
    get(connectionAtom);
    return Backend.use((client) => client("GitHubStatus", undefined));
  })
  .pipe(Atom.setIdleTTL("1 minute"));

/**
 * `gh auth login --web`, keyed by an attempt number: it runs while something reads it, so letting go
 * of it cancels the sign-in. Its value is the code to enter and the page to enter it on, then that
 * it's signed in.
 */
export const githubLoginAtom = Atom.family((_attempt: number) =>
  Backend.runtime.atom(
    Stream.unwrap(Backend.use((client) => Effect.succeed(client("LoginGitHub", undefined)))),
  ),
);

/** Counts up when a folder's repository may have changed: `gh` signed in, or a remote was added. */
const repositoryVersionAtom = Atom.family((_cwd: string) => Atom.make(0).pipe(Atom.keepAlive));

/** The GitHub repository a folder's remotes name, with what the signed-in account may do there. */
export const githubRepositoryAtom = Atom.family((cwd: string) =>
  Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      get(repositoryVersionAtom(cwd));
      return Backend.use((client) => client("GitHubRepository", { cwd }));
    })
    .pipe(Atom.setIdleTTL("5 minutes")),
);

export const refreshGitHubRepository = (registry: AtomRegistry.AtomRegistry, cwd: string) =>
  registry.update(repositoryVersionAtom(cwd), (count) => count + 1);

// ---------------------------------------------------------------------------------------------
// The list

/** Counts up whenever a folder's pull requests may have changed, so every page of its list is read again. */
export const pullListVersionAtom = Atom.family((_cwd: string) => Atom.make(0).pipe(Atom.keepAlive));

/** A page of a folder's pull requests, keyed `cwd`, the filters (see `pullFiltersKey`) and where it starts. */
export const pullPageKey = (cwd: string, filters: string, after: string | undefined) =>
  key(cwd, filters, after ?? "");

export const pullPageAtom = Atom.family((id: string) => {
  const [cwd = "", filters = "{}", after = ""] = id.split("\n");
  return Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      get(pullListVersionAtom(cwd));
      return Backend.use((client) =>
        client("ListPullRequests", {
          cwd,
          filters: pullFiltersOfKey(filters),
          ...(after === "" ? {} : { after }),
        }),
      );
    })
    .pipe(Atom.setIdleTTL("1 minute"));
});

/** The branch checked out in a folder, and its pull request when it has one. */
export const branchPullAtom = Atom.family((cwd: string) =>
  Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      get(pullListVersionAtom(cwd));
      return Backend.use((client) => client("BranchPullRequest", { cwd }));
    })
    .pipe(Atom.setIdleTTL("1 minute")),
);

export const refreshPullList = (registry: AtomRegistry.AtomRegistry, cwd: string) =>
  registry.update(pullListVersionAtom(cwd), (count) => count + 1);

// ---------------------------------------------------------------------------------------------
// One pull request

/** Keys a pull request by its folder and number. */
export const pullKey = (cwd: string, number: number) => key(cwd, String(number));

const parsePullKey = (id: string) => {
  const [cwd = "", number = "0", ...rest] = id.split("\n");
  return { cwd, number: Number(number), rest };
};

/** Counts up whenever a pull request may have changed, so it is read again. */
export const pullVersionAtom = Atom.family((_id: string) => Atom.make(0).pipe(Atom.keepAlive));

/** A pull request with the start of its conversation and every review thread, keyed with `pullKey`. */
export const pullAtom = Atom.family((id: string) => {
  const { cwd, number } = parsePullKey(id);
  return Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      get(pullVersionAtom(id));
      return Backend.use((client) => client("PullRequest", { cwd, number }));
    })
    .pipe(Atom.setIdleTTL("30 seconds"));
});

/** More of a pull request's conversation, from `after`; keyed `pullKey` and the cursor. */
export const pullTimelineKey = (id: string, after: string) => key(id, after);

export const pullTimelineAtom = Atom.family((pageKey: string) => {
  const { cwd, number, rest } = parsePullKey(pageKey);
  const id = pullKey(cwd, number);
  return Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      get(pullVersionAtom(id));
      return Backend.use((client) => client("PullRequestTimeline", { cwd, number, after: rest.join("\n") }));
    })
    .pipe(Atom.setIdleTTL("30 seconds"));
});

/** The checks on a pull request's latest commit, read again with the pull request. */
export const pullChecksAtom = Atom.family((id: string) => {
  const { cwd, number } = parsePullKey(id);
  return Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      get(pullVersionAtom(id));
      return Backend.use((client) => client("PullRequestChecks", { cwd, number }));
    })
    .pipe(Atom.setIdleTTL("30 seconds"));
});

/**
 * What only a push changes, keyed `pullKey` and the head commit, so a comment or a check doesn't read
 * them again: the commits, and the files with their diffs.
 */
export const pullHeadKey = (id: string, headOid: string) => key(id, headOid);

export const pullCommitsAtom = Atom.family((headKey: string) => {
  const { cwd, number } = parsePullKey(headKey);
  return Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      return Backend.use((client) => client("PullRequestCommits", { cwd, number }));
    })
    .pipe(Atom.setIdleTTL("1 minute"));
});

export const pullFilesAtom = Atom.family((headKey: string) => {
  const { cwd, number } = parsePullKey(headKey);
  return Backend.runtime
    .atom((get) => {
      get(connectionAtom);
      return Backend.use((client) => client("PullRequestFiles", { cwd, number }));
    })
    .pipe(Atom.setIdleTTL("1 minute"));
});

/** Reads a pull request again, and the list it's in. */
export const refreshPull = (registry: AtomRegistry.AtomRegistry, cwd: string, number: number) => {
  registry.update(pullVersionAtom(pullKey(cwd, number)), (count) => count + 1);
  refreshPullList(registry, cwd);
};

// ---------------------------------------------------------------------------------------------
// Doing things

export const isPullChanged = Backend.mutation("PullRequestChanged");
export const addGitHubComment = Backend.mutation("AddGitHubComment");
export const replyToReviewThread = Backend.mutation("ReplyToReviewThread");
export const resolveReviewThread = Backend.mutation("ResolveReviewThread");
export const submitReview = Backend.mutation("SubmitReview");
export const mergePull = Backend.mutation("MergePullRequest");
export const setPullState = Backend.mutation("SetPullRequestState");
export const setPullDraft = Backend.mutation("SetPullRequestDraft");
export const checkoutPull = Backend.mutation("CheckoutPullRequest");
export const createPull = Backend.mutation("CreatePullRequest");
