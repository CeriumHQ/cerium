import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { commitProblems, subjectProblem } from "../check-commits.ts";

describe("commit message rules", () => {
  it("accepts Conventional Commits subjects and rejects others", () => {
    expect(subjectProblem("feat(acp): close adapter parity")).toBeUndefined();
    expect(subjectProblem("ci: check pull request titles")).toBeUndefined();
    expect(subjectProblem("refactor(store,ui)!: replace schema")).toBeUndefined();
    expect(subjectProblem("Close ACP adapter parity (#86)")).toContain("type(scope): summary");
    expect(subjectProblem("feat: ")).toContain("type(scope): summary");
  });

  it("rejects commit bodies except on GitHub squash merges", () => {
    expect(commitProblems(["feat(acp): add hub", "", "extra body"], false)).toHaveLength(1);
    expect(commitProblems(["feat(acp): add hub (#86)", "", "* feat(acp): one"], true)).toEqual([]);
    expect(commitProblems(["Close ACP adapter parity (#86)", "", "* feat(acp): one"], true)).toHaveLength(1);
  });

  it("checks PR_TITLE alongside branch commits when run as a script", () => {
    const repo = mkdtempSync(join(tmpdir(), "cerium-commits-"));
    const script = join(import.meta.dirname, "..", "check-commits.ts");
    const { GITHUB_ACTIONS: _actions, PR_TITLE: _title, ...baseEnv } = process.env;
    try {
      const git = (...args: string[]) =>
        execFileSync(
          "git",
          [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "-c",
            "commit.gpgsign=false",
            ...args,
          ],
          { cwd: repo, encoding: "utf8" },
        ).trim();

      git("init", "-q", "-b", "main");
      git("commit", "-q", "--allow-empty", "-m", "chore: initial");
      const base = git("rev-parse", "HEAD");
      git("commit", "-q", "--allow-empty", "-m", "feat(acp): add hub");
      const head = git("rev-parse", "HEAD");

      const run = (extraEnv: Record<string, string>) =>
        spawnSync(process.execPath, [script, base, head], {
          cwd: repo,
          encoding: "utf8",
          env: { ...baseEnv, ...extraEnv },
        });

      const bad = run({ PR_TITLE: "Close ACP adapter parity" });
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("PR title: Close ACP adapter parity");

      const good = run({ PR_TITLE: "feat(acp): close adapter parity" });
      expect(good.status).toBe(0);
      expect(good.stdout).toContain("and the pull request title");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
