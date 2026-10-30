import { describe, expect, it } from "@effect/vitest";

import {
  checkoutDetail,
  checkoutsMatching,
  linkKindOf,
  pathTail,
  pullFacts,
  samePath,
  statusWords,
  worktreeChoice,
  worktreeForm,
  worktreeLabel,
} from "../src/features/git/workspace.ts";

const checkout = (path: string, branch: string, threads: Array<{ title: string; active: boolean }> = []) => ({
  id: path,
  path,
  branch,
  head: "abc",
  detached: false,
  threads: threads.map((thread, index) => ({ id: `t${index}`, ...thread })),
});

describe("workspace", () => {
  it("compares Windows paths whatever their slashes and case", () => {
    expect(samePath("C:\\Repo\\cerium\\", "c:/repo/cerium")).toBe(true);
    expect(samePath("/home/me/Repo", "/home/me/repo")).toBe(false);
    expect(pathTail("C:\\Users\\me\\.cerium\\worktrees\\cerium\\fix-it")).toBe("cerium/fix-it");
  });

  it("names a checkout's folder only where its branch doesn't", () => {
    expect(checkoutDetail(checkout("/w/cerium/fix-it", "cerium/fix-it"))).toBeUndefined();
    expect(checkoutDetail(checkout("/p/cerium", "main"))).toBe("cerium");
    expect(
      checkoutDetail(checkout("/w/cerium/fix-it", "cerium/fix-it", [{ title: "Fix it", active: true }])),
    ).toBe("Fix it");
    expect(
      checkoutDetail(
        checkout("/p/cerium", "main", [
          { title: "A", active: true },
          { title: "B", active: true },
          { title: "C", active: false },
        ]),
      ),
    ).toBe("cerium · 2 threads");
  });

  it("lists checkouts on a branch, leaving out the ones asked and matching the query", () => {
    const all = [
      checkout("/p/cerium", "main"),
      checkout("/w/cerium/fix-it", "cerium/fix-it"),
      { ...checkout("/w/cerium/old", ""), detached: true },
    ];
    expect(checkoutsMatching(all, "").map((one) => one.branch)).toEqual(["main", "cerium/fix-it"]);
    expect(checkoutsMatching(all, "", ["/p/cerium/"]).map((one) => one.branch)).toEqual(["cerium/fix-it"]);
    expect(checkoutsMatching(all, "FIX").map((one) => one.branch)).toEqual(["cerium/fix-it"]);
  });

  it("tells a pull request's address from an issue's", () => {
    expect(linkKindOf("https://github.com/CeriumHQ/cerium/pull/25")).toBe("pull");
    expect(linkKindOf(" https://github.com/CeriumHQ/cerium/issues/7/ ")).toBe("issue");
    expect(linkKindOf("https://github.com/CeriumHQ/cerium/pull/25/files")).toBeUndefined();
    expect(linkKindOf("not a link")).toBeUndefined();
  });

  it("says a checkout's state and a pull request's in words", () => {
    expect(statusWords({ staged: 1, unstaged: 2, conflicted: 0, ahead: 3, behind: 0 })).toEqual([
      "3 changed",
      "3 to push",
    ]);
    expect(statusWords({ staged: 0, unstaged: 0, conflicted: 0, ahead: 0, behind: 0 })).toEqual([]);
    expect(pullFacts({ checks: "failed", review: "APPROVED" }).map((fact) => fact.word)).toEqual([
      "Checks fail",
      "Approved",
    ]);
    expect(pullFacts({ checks: "none", review: "none" })).toEqual([]);
  });

  it("asks of a new worktree only what its source needs", () => {
    const blank = worktreeForm(undefined, "main");
    expect(worktreeChoice(blank)).toEqual({ baseRef: "main" });
    expect(worktreeChoice({ ...blank, branch: " fix-it " })).toEqual({ baseRef: "main", branch: "fix-it" });
    expect(worktreeChoice({ ...blank, base: " " })).toBeUndefined();
    expect(worktreeChoice({ ...blank, source: "existing", existing: "topic", branch: "ignored" })).toEqual({
      existingBranch: "topic",
    });
    expect(worktreeChoice({ ...blank, source: "pull", pullUrl: "https://github.com/o/r/issues/1" })).toBe(
      undefined,
    );
    expect(
      worktreeChoice({ ...blank, source: "thread", thread: { id: "thr_1", branch: "cerium/a" } }),
    ).toEqual({
      sourceThreadId: "thr_1",
      baseRef: "cerium/a",
    });
  });

  it("fills the form back in from a saved choice", () => {
    const choice = { pullRequestUrl: "https://github.com/o/r/pull/9", branch: "review-9" };
    expect(worktreeForm(choice, "main")).toMatchObject({ source: "pull", branch: "review-9" });
    expect(worktreeChoice(worktreeForm(choice, "main"))).toEqual(choice);
    expect(worktreeLabel({ pullRequestUrl: "https://github.com/o/r/pull/9" })).toBe("PR #9");
    expect(worktreeLabel(undefined)).toBe("New worktree");
  });
});
