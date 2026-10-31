import type { GitBranchList, GitBranchState, LocalBranch, RemoteBranch, UnmergedFile } from "@cerium/rpc";
import { describe, expect, it } from "@effect/vitest";

import {
  branchNameProblem,
  branchTitle,
  canSkip,
  conflictNote,
  matchBranches,
  operationTitle,
  sideHelp,
  switchBlocked,
  syncHint,
  syncPlan,
} from "../src/features/git/branches/model.ts";

const state = (overrides: Partial<GitBranchState> = {}): GitBranchState => ({
  repository: true,
  branch: "main",
  remotes: ["origin"],
  changes: 0,
  conflicts: [],
  ...overrides,
});

/** HEAD on a commit, or on no commit at all in a repository that has none. */
const headless = (commit?: string): GitBranchState => ({
  repository: true,
  remotes: ["origin"],
  changes: 0,
  conflicts: [],
  ...(commit === undefined ? {} : { commit, detached: true }),
});

const local = (name: string, overrides: Partial<LocalBranch> = {}): LocalBranch => ({
  name,
  current: false,
  committedAt: 0,
  subject: "",
  ...overrides,
});

const remote = (name: string, overrides: Partial<RemoteBranch> = {}): RemoteBranch => ({
  name,
  remote: name.split("/")[0]!,
  committedAt: 0,
  subject: "",
  ...overrides,
});

describe("branch title", () => {
  it("names the branch, or the commit when HEAD is on none", () => {
    expect(branchTitle(state())).toEqual({ name: "main", detached: false });
    expect(branchTitle(headless("1a2b3c4"))).toEqual({ name: "1a2b3c4", detached: true });
    expect(branchTitle(headless())).toEqual({ name: "No commits yet", detached: false });
  });
});

describe("branch name problems", () => {
  it("accepts what git accepts", () => {
    for (const name of ["feature/login", "fix-12", "release/1.2.x", "über"]) {
      expect(branchNameProblem(name)).toBeUndefined();
    }
  });

  it("explains what it refuses", () => {
    for (const name of [
      "",
      "a b",
      "-x",
      ".x",
      "/x",
      "x/",
      "x.",
      "x.lock",
      "a..b",
      "a@{b",
      "a//b",
      "a~b",
      "a^b",
      "a:b",
      "a?b",
      "a*b",
      "a[b",
      "a\\b",
      "a\u0001b",
      "@",
      "HEAD",
    ]) {
      expect([name, typeof branchNameProblem(name)]).toEqual([name, "string"]);
    }
  });
});

describe("branch search", () => {
  const list: GitBranchList = {
    local: [local("main"), local("feature/login"), local("login-fix")],
    remote: [remote("origin/main", { local: "main" }), remote("origin/release"), remote("origin/login-v2")],
  };

  it("lists every local branch and the remote ones nothing follows when nothing is typed", () => {
    const shown = matchBranches(list, "");
    expect(shown.local.map((branch) => branch.name)).toEqual(["main", "feature/login", "login-fix"]);
    expect(shown.remote.map((branch) => branch.name)).toEqual(["origin/release", "origin/login-v2"]);
  });

  it("matches anywhere in the name, ignoring case, earlier matches first", () => {
    const shown = matchBranches(list, "LOGIN");
    expect(shown.local.map((branch) => branch.name)).toEqual(["login-fix", "feature/login"]);
    expect(shown.remote.map((branch) => branch.name)).toEqual(["origin/login-v2"]);
  });
});

describe("branch rows", () => {
  it("explains a branch that another worktree holds", () => {
    expect(switchBlocked(local("x"))).toBeUndefined();
    expect(switchBlocked(local("x", { checkedOutAt: "C:/work/x" }))).toContain("another worktree");
  });
});

describe("sync plan", () => {
  const following = (ahead: number, behind: number) =>
    state({ upstream: { name: "origin/main", ahead, behind, gone: false } });

  it("pulls when behind, pushes when ahead, fetches when level", () => {
    expect(syncPlan(following(0, 3)).primary).toBe("pull");
    expect(syncPlan(following(2, 0)).primary).toBe("push");
    expect(syncPlan(following(0, 0)).primary).toBe("fetch");
  });

  it("pulls first when both have moved on", () => {
    const plan = syncPlan(following(2, 3));
    expect(plan.primary).toBe("pull");
    expect(plan.diverged).toBe(true);
    expect(syncHint(plan, "origin/main")).toContain("Pull first");
  });

  it("publishes a branch the remote has none of, or lost", () => {
    const fresh = syncPlan(state());
    expect(fresh.primary).toBe("publish");
    expect(fresh.can).toMatchObject({ publish: true, pull: false, push: false, force: false });
    const gone = syncPlan(state({ upstream: { name: "origin/main", ahead: 0, behind: 0, gone: true } }));
    expect(gone.primary).toBe("publish");
    expect(gone.gone).toBe(true);
    expect(syncHint(gone, "origin/main")).toContain("no longer exists");
  });

  it("offers force push only to a branch that follows one", () => {
    expect(syncPlan(following(1, 0)).can.force).toBe(true);
    expect(syncPlan(state()).can.force).toBe(false);
  });

  it("hides with no remote, with HEAD on a commit, or while an operation waits", () => {
    expect(syncPlan(state({ remotes: [] })).hidden).toBe(true);
    expect(syncPlan(state({ operation: { kind: "merge" } })).hidden).toBe(true);
    expect(syncPlan(headless("1a2b3c4")).hidden).toBe(true);
    expect(syncPlan(state()).hidden).toBe(false);
  });

  it("says where the branch stands", () => {
    expect(syncHint(syncPlan(following(0, 0)), "origin/main")).toBe("Up to date with origin/main.");
    expect(syncHint(syncPlan(following(2, 0)), "origin/main")).toBe("2 not on origin/main yet.");
    expect(syncHint(syncPlan(following(0, 4)), "origin/main")).toBe("4 new on origin/main.");
    expect(syncHint(syncPlan(state()), undefined)).toContain("isn't on the remote");
  });
});

describe("an operation that stopped", () => {
  const conflict = (path: string, overrides: Partial<UnmergedFile> = {}): UnmergedFile => ({
    path,
    ours: "modified",
    theirs: "modified",
    ...overrides,
  });

  it("titles the operation and how far a rebase is", () => {
    expect(operationTitle(state({ operation: { kind: "merge" } }))).toBe("Merge in progress");
    expect(operationTitle(state({ operation: { kind: "cherry-pick" } }))).toBe("Cherry-pick in progress");
    expect(operationTitle(state({ operation: { kind: "rebase", step: 2, total: 5 } }))).toBe(
      "Rebase in progress (step 2 of 5)",
    );
    expect(operationTitle(state({ operation: { kind: "rebase", step: 1, total: 1 } }))).toBe(
      "Rebase in progress",
    );
    expect(operationTitle(state({ conflicts: [conflict("a")] }))).toBe("Conflicts to resolve");
  });

  it("skips a step of everything but a merge", () => {
    expect(canSkip("merge")).toBe(false);
    for (const kind of ["rebase", "cherry-pick", "revert"] as const) expect(canSkip(kind)).toBe(true);
  });

  it("explains which side is which, since a rebase swaps them", () => {
    expect(sideHelp("merge", "theirs")).toContain("merged in");
    expect(sideHelp("rebase", "ours")).toContain("rebased onto");
    expect(sideHelp("rebase", "theirs")).toContain("your own change");
    expect(sideHelp("cherry-pick", "theirs")).toContain("picked");
    expect(sideHelp(undefined, "ours")).toContain("you're on");
  });

  it("describes what each side did to a file", () => {
    expect(conflictNote(conflict("a"))).toBe("Changed on both sides");
    expect(conflictNote(conflict("a", { ours: "added", theirs: "added" }))).toBe("Added on both sides");
    expect(conflictNote(conflict("a", { ours: "deleted", theirs: "modified" }))).toBe(
      "Deleted here, changed there",
    );
    expect(conflictNote(conflict("a", { ours: "modified", theirs: "deleted" }))).toBe(
      "Changed here, deleted there",
    );
  });
});
