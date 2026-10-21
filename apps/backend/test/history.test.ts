import { describe, expect, it } from "@effect/vitest";

import {
  FIELD,
  isSha,
  logFormat,
  mergeCommits,
  parseCommits,
  parseNameStatus,
  parseRefs,
  RECORD,
} from "../src/history.ts";

/** One commit's record as `git log --format=logFormat` prints it. */
const record = (fields: ReadonlyArray<string>) => `${RECORD}${fields.join(FIELD)}`;

describe("parseRefs", () => {
  it("names the checked-out branch, local branches, tags and upstreams", () => {
    expect(
      parseRefs(
        "HEAD -> refs/heads/main, tag: refs/tags/v1.2.0, refs/remotes/origin/main, refs/heads/feat/x",
      ),
    ).toEqual([
      { kind: "branch", name: "main", current: true },
      { kind: "tag", name: "v1.2.0" },
      { kind: "upstream", name: "origin/main" },
      { kind: "branch", name: "feat/x" },
    ]);
  });

  it("leaves out a detached HEAD and a remote's own HEAD", () => {
    expect(parseRefs("HEAD, refs/remotes/origin/HEAD")).toEqual([]);
    expect(parseRefs("")).toEqual([]);
  });
});

describe("parseCommits", () => {
  it("reads each commit's fields, its refs and its parents", () => {
    const output = [
      record([
        "a".repeat(40),
        "aaaaaaa",
        "b".repeat(40),
        "Ann Lee",
        "1700000000",
        "1700000100",
        "HEAD -> refs/heads/main, refs/remotes/origin/main",
        "Fix login bug",
      ]),
      record(["b".repeat(40), "bbbbbbb", "", "Bob Ray", "1600000000", "1600000000", "", "First"]),
    ].join("");
    const commits = parseCommits(output);
    expect(commits.map((item) => item.commit.subject)).toEqual(["Fix login bug", "First"]);
    expect(commits[0]!.commit).toEqual({
      sha: "a".repeat(40),
      short: "aaaaaaa",
      subject: "Fix login bug",
      author: "Ann Lee",
      at: 1_700_000_000_000,
      refs: [
        { kind: "branch", name: "main", current: true },
        { kind: "upstream", name: "origin/main" },
      ],
    });
    expect(commits[0]!.committed).toBe(1_700_000_100_000);
    expect(commits[0]!.parents).toEqual(["b".repeat(40)]);
    expect(commits[1]!.parents).toEqual([]);
  });

  it("keeps the whole message when asked, with its own line breaks and separators left as written", () => {
    const output = record([
      "c".repeat(40),
      "ccccccc",
      "",
      "Cy",
      "1",
      "1",
      "",
      "Subject",
      "Subject\n\nBody line\n",
    ]);
    expect(parseCommits(output, true)[0]!.message).toBe("Subject\n\nBody line");
  });

  it("skips a record that holds no SHA", () => {
    expect(parseCommits(`${RECORD}${FIELD}${FIELD}`)).toEqual([]);
  });

  it("asks git for the fields in that order", () => {
    expect(logFormat(false)).toBe("--format=\x1e%H\x1f%h\x1f%P\x1f%an\x1f%at\x1f%ct\x1f%D\x1f%s");
    expect(logFormat(true).endsWith("\x1f%s\x1f%B")).toBe(true);
  });
});

describe("parseNameStatus", () => {
  it("lists what a commit changed, as git's -z output gives it", () => {
    const output = [
      "M",
      "src/a.ts",
      "A",
      "src/new.ts",
      "D",
      "gone.txt",
      "R100",
      "src/old.ts",
      "src/moved.ts",
      "",
    ].join("\0");
    expect(parseNameStatus(output, "")).toEqual([
      { path: "src/a.ts", state: "modified" },
      { path: "src/new.ts", state: "added" },
      { path: "gone.txt", state: "deleted" },
      { path: "src/moved.ts", state: "renamed", from: "src/old.ts" },
    ]);
  });

  it("lists only the folder's files, relative to it", () => {
    const output = ["M", "apps/ui/src/a.ts", "M", "README.md", "R090", "apps/ui/x.ts", "apps/ui/y.ts"].join(
      "\0",
    );
    expect(parseNameStatus(output, "apps/ui/")).toEqual([
      { path: "src/a.ts", state: "modified" },
      { path: "y.ts", state: "renamed", from: "x.ts" },
    ]);
  });

  it("shows a move into the folder as added, and a move out of it as deleted", () => {
    const output = ["R100", "outside.ts", "apps/ui/inside.ts", "R100", "apps/ui/out.ts", "outside2.ts"].join(
      "\0",
    );
    expect(parseNameStatus(output, "apps/ui/")).toEqual([
      { path: "inside.ts", state: "added" },
      { path: "out.ts", state: "deleted" },
    ]);
  });
});

describe("mergeCommits", () => {
  const at = (sha: string, committed: number) => ({
    commit: { sha, short: sha.slice(0, 4), subject: sha, author: "", at: committed, refs: [] },
    committed,
    parents: [],
  });

  it("merges newest first and keeps one copy of a commit both lists hold", () => {
    const merged = mergeCommits([at("c3", 3000), at("c1", 1000)], [at("c2", 2000), at("c3", 3000)]);
    expect(merged.map((item) => item.commit.sha)).toEqual(["c3", "c2", "c1"]);
  });
});

describe("isSha", () => {
  it("takes full and abbreviated hexadecimal names only", () => {
    expect(isSha("8be9dbc684e20a31f593afa76b05fbaa3b24719a")).toBe(true);
    expect(isSha("8be9d")).toBe(true);
    expect(isSha("--output=/tmp/x")).toBe(false);
    expect(isSha("HEAD")).toBe(false);
    expect(isSha("abc")).toBe(false);
  });
});
