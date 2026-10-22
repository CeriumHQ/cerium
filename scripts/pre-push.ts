// Runs before every `git push`, from .vite-hooks/pre-push, which `bun install` sets up: every check CI
// runs that this machine can run too, so a push that would turn CI red stops here. That is
// `bun run verify`, the commit-message check on the commits being pushed, and the workflow linters
// when the push changes .github. Each runs even when an earlier one fails, so one push reports every
// problem. CI goes further (tests on the other platform, packaging, publishing), so a pushed commit is
// still watched there. Verify checks the working tree, which can hold another thread's unfinished work.
//
// Usage: node scripts/pre-push.ts, with git's pre-push lines on stdin
// (`<local ref> <local sha> <remote ref> <remote sha>`). Without them it checks origin/main..HEAD.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Pushed {
  /** The remote's commit before the push; all zeros for a new branch. */
  readonly base: string;
  readonly head: string;
}

const zeros = /^0+$/;

/** What each pushed ref adds, from git's pre-push lines. A deleted ref adds nothing. */
export const pushedRanges = (input: string): Pushed[] =>
  input
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .flatMap(([, head = "", , base = ""]) => (head === "" || zeros.test(head) ? [] : [{ base, head }]));

/** Whether a push changing these paths needs the workflow linters. */
export const touchesWorkflows = (paths: readonly string[]): boolean =>
  paths.some((path) => path.startsWith(".github/"));

if (import.meta.main) {
  const root = join(import.meta.dirname, "..");
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const inHistory = (rev: string): boolean => {
    if (rev === "" || zeros.test(rev)) return false;
    try {
      git("cat-file", "-e", `${rev}^{commit}`);
      return true;
    } catch {
      return false;
    }
  };
  const run = (label: string, command: string, args: readonly string[]): boolean => {
    console.log(`\n> ${label}`);
    // The shell finds bun however it's installed (bun.exe, or a .cmd shim on Windows).
    const shell = command !== process.execPath;
    return spawnSync(command, args, { cwd: root, stdio: "inherit", shell }).status === 0;
  };

  const input = process.stdin.isTTY ? "" : readFileSync(0, "utf8");
  const ranges =
    input.trim() === "" ? [{ base: git("rev-parse", "origin/main"), head: "HEAD" }] : pushedRanges(input);

  let passed = true;
  if (ranges.length > 0) {
    let workflows = false;
    for (const { base, head } of ranges) {
      passed =
        run("Commit messages", process.execPath, [join(root, "scripts", "check-commits.ts"), base, head]) &&
        passed;
      // A new branch has no base to compare with, so its workflows are linted whatever it changed.
      workflows ||= !inHistory(base) || touchesWorkflows(git("diff", "--name-only", base, head).split("\n"));
    }
    if (workflows) passed = run("Workflows", "bun run lint:workflows", []) && passed;
    passed = run("Verify", "bun run verify", []) && passed;
  }

  if (!passed) {
    console.error("\nThe push stopped: CI would fail on what failed above. Fix it, commit, and push again.");
    process.exitCode = 1;
  }
}
