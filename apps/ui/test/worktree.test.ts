import type { ThreadId } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";

import { toThreadSummary } from "../src/backend/view.ts";
import { archiveWarning } from "../src/features/threads/worktree.ts";

const worktree = { branch: "cerium/fix-login", base: "main" };

describe("archiveWarning", () => {
  it("says uncommitted changes are discarded", () => {
    expect(archiveWarning({ uncommitted: 1, unmerged: 0 }, worktree)).toEqual({
      holds: "1 uncommitted change",
      outcome: "Archiving removes its worktree and discards them.",
    });
  });

  it("says unmerged commits stay on the branch", () => {
    expect(archiveWarning({ uncommitted: 0, unmerged: 2 }, worktree)).toEqual({
      holds: "2 commits not merged into main",
      outcome: "Archiving removes its worktree; the commits stay on cerium/fix-login.",
    });
  });

  it("names both when there are both", () => {
    expect(archiveWarning({ uncommitted: 3, unmerged: 1 }, worktree)).toEqual({
      holds: "3 uncommitted changes and 1 commit not merged into main",
      outcome:
        "Archiving removes its worktree and discards the changes; the commit stays on cerium/fix-login.",
    });
  });
});

describe("a thread in a worktree", () => {
  it("is listed with its project, and carries its branch", () => {
    const summary = toThreadSummary({
      thread: {
        id: "thr_1" as ThreadId,
        title: "Fix login",
        mode: "work",
        cwd: "C:\\Users\\me\\.cerium\\worktrees\\app\\fix-login",
        worktree: {
          project: "C:\\Projects\\app",
          root: "C:\\Users\\me\\.cerium\\worktrees\\app\\fix-login",
          ...worktree,
        },
        createdAt: 1,
        updatedAt: 1,
      },
      agents: [],
      awaitingApproval: false,
    });
    expect(summary.project).toBe("app");
    expect(summary.folder).toBe("C:\\Projects\\app");
    expect(summary.worktree).toEqual(worktree);
  });
});
