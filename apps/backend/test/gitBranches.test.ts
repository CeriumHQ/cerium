import { describe, expect, it } from "@effect/vitest";

import {
  conflictSides,
  explainFailure,
  parseBranches,
  parseGitStatus,
  parseStashes,
  parseTrack,
  saysUnchanged,
} from "../src/gitBranches.ts";

describe("git's complaints", () => {
  it("says a rejected push needs a pull first", () => {
    const text = [
      "To C:/remote.git",
      " ! [rejected]        main -> main (fetch first)",
      "error: failed to push some refs to 'C:/remote.git'",
    ].join("\n");
    expect(explainFailure(text, "x")).toBe(
      "The remote has commits you don't have yet. Pull first, then push again.",
    );
    expect(explainFailure("! [rejected] main -> main (non-fast-forward)", "x")).toContain("Pull first");
  });

  it("says a forced push's lease ran out", () => {
    expect(explainFailure("! [rejected] main -> main (stale info)", "x")).toContain("Fetch");
  });

  it("says when the remote refused for its own reason", () => {
    expect(explainFailure(" ! [remote rejected] main -> main (protected branch hook declined)", "x")).toBe(
      "The remote refused the push: protected branch hook declined.",
    );
  });

  it("sends a failed sign-in to git's credential helper", () => {
    for (const text of [
      "fatal: Authentication failed for 'https://example.com/a.git/'",
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      "git@github.com: Permission denied (publickey).",
      "remote: Repository not found.\nfatal: repository 'https://github.com/a/b.git/' not found",
      "fatal: unable to access 'https://x/': The requested URL returned error: 403",
    ]) {
      expect([text, explainFailure(text, "x")]).toEqual([
        text,
        "Git couldn't sign in to the remote. Sign in through git's credential helper (for example, run git fetch once in a terminal), then try again.",
      ]);
    }
  });

  it("says when the remote can't be reached", () => {
    for (const text of [
      "fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com",
      "ssh: connect to host github.com port 22: Connection timed out",
      "fatal: unable to access 'x': Failed to connect to github.com port 443",
    ]) {
      expect([text, explainFailure(text, "x")]).toEqual([
        text,
        "Can't reach the remote. Check your connection and try again.",
      ]);
    }
  });

  it("names the worktree that has a branch", () => {
    const message = explainFailure("fatal: 'main' is already used by worktree at 'C:/work/app'", "x");
    expect(message).toContain("main is already checked out in another worktree (C:/work/app)");
    expect(explainFailure("fatal: 'dev' is already checked out at '/home/a'", "x")).toContain("/home/a");
  });

  it("asks for changes to be committed or stashed when they are in the way", () => {
    expect(
      explainFailure(
        "error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\nPlease commit your changes or stash them before you switch branches.",
        "x",
      ),
    ).toContain("Commit or stash them first");
    expect(
      explainFailure(
        "error: The following untracked working tree files would be overwritten by checkout:\n\tb",
        "x",
      ),
    ).toContain("Untracked files in the way");
  });

  it("explains the rest of what people meet", () => {
    expect(explainFailure("fatal: The current branch dev has no upstream branch.", "x")).toContain("Publish");
    expect(explainFailure("There is no tracking information for the current branch.", "x")).toContain(
      "Publish",
    );
    expect(explainFailure("fatal: refusing to merge unrelated histories", "x")).toContain(
      "no history in common",
    );
    expect(explainFailure("fatal: A branch named 'dev' already exists.", "x")).toBe(
      "A branch named dev already exists.",
    );
    expect(explainFailure("fatal: 'a b' is not a valid branch name", "x")).toBe(
      "That isn't a valid branch name.",
    );
    expect(explainFailure("fatal: invalid reference: nope", "x")).toBe("Git doesn't know that branch.");
    expect(explainFailure("merge: nope - not something we can merge", "x")).toBe(
      "Git doesn't know that branch.",
    );
    expect(explainFailure("fatal: You have not concluded your merge (MERGE_HEAD exists).", "x")).toContain(
      "Finish or abort",
    );
    expect(explainFailure("Author identity unknown\n*** Please tell me who you are.", "x")).toContain(
      "who you are",
    );
    expect(explainFailure("fatal: Unable to create '/r/.git/index.lock': File exists.", "x")).toContain(
      "Another git process",
    );
    expect(explainFailure("fatal: Cannot delete branch 'main' checked out at '/r'", "x")).toContain(
      "checked out",
    );
  });

  it("falls back to git's last complaint, or to the caller's words", () => {
    expect(explainFailure("hint: stuff\nerror: something odd\nfatal: the odd thing", "x")).toBe(
      "the odd thing",
    );
    expect(explainFailure("hint: nothing useful", "Couldn't do it.")).toBe("Couldn't do it.");
    expect(explainFailure("", "Couldn't do it.")).toBe("Couldn't do it.");
  });

  it("reads 'nothing to do' in git's output", () => {
    expect(saysUnchanged("Already up to date.")).toBe(true);
    expect(saysUnchanged("Everything up-to-date")).toBe(true);
    expect(saysUnchanged("No local changes to save")).toBe(true);
    expect(saysUnchanged("Fast-forward")).toBe(false);
  });
});

describe("git status", () => {
  const status = (...lines: Array<string>) => `${lines.join("\0")}\0`;
  const oid = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";

  it("reads the branch, its upstream and how far apart they are", () => {
    const parsed = parseGitStatus(
      status(
        `# branch.oid ${oid}`,
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +2 -3",
        "1 .M N... 100644 100644 100644 aaa bbb src/a.ts",
        "? new file.txt",
      ),
    );
    expect(parsed).toEqual({
      branch: "main",
      commit: "1a2b3c4",
      detached: false,
      upstream: { name: "origin/main", ahead: 2, behind: 3, gone: false },
      changes: 2,
      unmerged: [],
    });
  });

  it("says an upstream with no counts is gone", () => {
    const parsed = parseGitStatus(
      status(`# branch.oid ${oid}`, "# branch.head dev", "# branch.upstream origin/dev"),
    );
    expect(parsed.upstream).toEqual({ name: "origin/dev", ahead: 0, behind: 0, gone: true });
  });

  it("reads a detached HEAD and a repository without commits", () => {
    const detached = parseGitStatus(status(`# branch.oid ${oid}`, "# branch.head (detached)"));
    expect(detached.branch).toBeUndefined();
    expect(detached.detached).toBe(true);
    expect(detached.commit).toBe("1a2b3c4");
    const unborn = parseGitStatus(status("# branch.oid (initial)", "# branch.head main"));
    expect(unborn.branch).toBe("main");
    expect(unborn.commit).toBeUndefined();
  });

  it("counts a rename once and keeps the spaces in paths", () => {
    const parsed = parseGitStatus(
      status(
        `# branch.oid ${oid}`,
        "# branch.head main",
        "2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt",
        "old name.txt",
        "u UU N... 100644 100644 100644 100644 aaa bbb ccc dir/with space.txt",
        "u DU N... 100644 000000 100644 100644 aaa 000 ccc gone.txt",
      ),
    );
    expect(parsed.changes).toBe(3);
    expect(parsed.unmerged).toEqual([
      { xy: "UU", path: "dir/with space.txt" },
      { xy: "DU", path: "gone.txt" },
    ]);
  });

  it("reads what each side of a conflict did", () => {
    expect(conflictSides("UU")).toEqual({ ours: "modified", theirs: "modified" });
    expect(conflictSides("AA")).toEqual({ ours: "added", theirs: "added" });
    expect(conflictSides("DD")).toEqual({ ours: "deleted", theirs: "deleted" });
    expect(conflictSides("UD")).toEqual({ ours: "modified", theirs: "deleted" });
    expect(conflictSides("DU")).toEqual({ ours: "deleted", theirs: "modified" });
    expect(conflictSides("AU")).toEqual({ ours: "added", theirs: "deleted" });
    expect(conflictSides("UA")).toEqual({ ours: "deleted", theirs: "added" });
  });
});

describe("branch lists", () => {
  const line = (...fields: Array<string>) => fields.join("\0");

  it("reads a branch's upstream distance", () => {
    expect(parseTrack("", "")).toBeUndefined();
    expect(parseTrack("origin/a", "")).toEqual({ name: "origin/a", ahead: 0, behind: 0, gone: false });
    expect(parseTrack("origin/a", "[ahead 2, behind 5]")).toEqual({
      name: "origin/a",
      ahead: 2,
      behind: 5,
      gone: false,
    });
    expect(parseTrack("origin/a", "[gone]")).toEqual({ name: "origin/a", ahead: 0, behind: 0, gone: true });
  });

  it("splits local from remote branches, and finds each remote's follower", () => {
    const output = [
      line("refs/heads/main", "*", "origin/main", "[ahead 1]", "C:/work", "300", "tip"),
      line("refs/heads/feature", " ", "", "", "C:/other", "200", "wip"),
      line("refs/remotes/origin/HEAD", " ", "", "", "", "100", "tip"),
      line("refs/remotes/origin/main", " ", "", "", "", "300", "tip"),
      line("refs/remotes/team/fix/a", " ", "", "", "", "50", "fix"),
      "",
    ].join("\n");
    const { local, remote } = parseBranches(output, ["origin", "team"]);
    expect(local).toEqual([
      {
        name: "main",
        current: true,
        upstream: { name: "origin/main", ahead: 1, behind: 0, gone: false },
        committedAt: 300,
        subject: "tip",
      },
      { name: "feature", current: false, checkedOutAt: "C:/other", committedAt: 200, subject: "wip" },
    ]);
    expect(remote).toEqual([
      { name: "origin/main", remote: "origin", local: "main", committedAt: 300, subject: "tip" },
      { name: "team/fix/a", remote: "team", committedAt: 50, subject: "fix" },
    ]);
  });

  it("names the first listed of the local branches that follow the same remote one", () => {
    const output = [
      line("refs/heads/newer", " ", "origin/main", "", "", "300", "a"),
      line("refs/heads/main", "*", "origin/main", "", "", "200", "b"),
      line("refs/remotes/origin/main", " ", "", "", "", "200", "b"),
    ].join("\n");
    expect(parseBranches(output, ["origin"]).remote.map((branch) => branch.local)).toEqual(["newer"]);
  });

  it("reads stashes, the user's words and git's own", () => {
    const output = [
      ["abc123abc123", "On main: before the refactor", "1700000000"].join("\0"),
      ["def456def456", "WIP on dev: 1a2b3c4 add the thing", "1600000000"].join("\0"),
      ["fff000fff000", "On (no branch): loose", "1500000000"].join("\0"),
      "",
    ].join("\n");
    expect(parseStashes(output)).toEqual([
      { commit: "abc123abc123", message: "before the refactor", branch: "main", at: 1700000000 },
      { commit: "def456def456", message: "add the thing", branch: "dev", at: 1600000000 },
      { commit: "fff000fff000", message: "loose", at: 1500000000 },
    ]);
  });
});
