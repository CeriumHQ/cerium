// Checks commit messages against the repository's rules: one Conventional Commits subject
// line (`type(scope): summary`) with no body and no trailers. CI runs it on every push and pull
// request, and also checks the pull request title (via PR_TITLE) so a squash merge cannot land a
// non-conforming subject on main.
//
// Usage: node scripts/check-commits.ts <base> [head]
// Checks base..head, or only head when base is empty, all zeros (a new branch) or not in the history.
// Merge commits and commits authored by bots (Dependabot) are skipped. A pull request's squash merge,
// which GitHub commits, is held to its subject only: GitHub fills its body with the branch's commits,
// which the pull request's own run already checked.

import { execFileSync } from "node:child_process";

const types = ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"];
const subjectPattern = new RegExp(`^(${types.join("|")})(\\([a-z0-9-]+(,[a-z0-9-]+)*\\))?!?: \\S`);
const botAuthor = /\[bot\]@users\.noreply\.github\.com$/;

export const subjectProblem = (subject: string): string | undefined =>
  subjectPattern.test(subject)
    ? undefined
    : `the subject must read \`type(scope): summary\` with a type from: ${types.join(", ")}`;

export const commitProblems = (lines: readonly string[], squashMerge: boolean): string[] => {
  const [subject = "", ...rest] = lines;
  const problems: string[] = [];
  const subjectIssue = subjectProblem(subject);
  if (subjectIssue !== undefined) problems.push(subjectIssue);
  const extra = squashMerge ? undefined : rest.find((line) => line.trim() !== "");
  if (extra !== undefined) {
    problems.push(`only the subject line is allowed, with no body or trailers (found "${extra.trim()}")`);
  }
  return problems;
};

const escape = (text: string): string =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

if (import.meta.main) {
  const [base = "", head = "HEAD"] = process.argv.slice(2);

  const git = (...args: string[]): string =>
    execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  const inHistory = (rev: string): boolean => {
    if (rev === "" || /^0+$/.test(rev)) return false;
    try {
      git("cat-file", "-e", `${rev}^{commit}`);
      return true;
    } catch {
      return false;
    }
  };

  const range = inHistory(base) ? [`${base}..${head}`] : ["-1", head];
  const commits = git("log", "--format=%H%x00%P%x00%ae%x00%ce%x00%B%x1e", ...range)
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record !== "")
    .map((record) => {
      const [hash = "", parents = "", email = "", committer = "", message = ""] = record.split("\0");
      return {
        hash,
        parents: parents.split(" ").filter(Boolean),
        email,
        squashMerge: committer === "noreply@github.com",
        lines: message.trimEnd().split("\n"),
      };
    });

  const annotate = process.env["GITHUB_ACTIONS"] === "true";

  let checked = 0;
  let failed = 0;
  for (const { hash, parents, email, squashMerge, lines } of commits) {
    if (parents.length > 1 || botAuthor.test(email)) continue;
    checked++;
    const [subject = ""] = lines;
    const problems = commitProblems(lines, squashMerge);
    if (problems.length === 0) continue;
    failed++;
    const short = hash.slice(0, 7);
    for (const problem of problems) {
      if (annotate) console.log(`::error title=Commit ${short}::${escape(`${subject} — ${problem}`)}`);
      else console.error(`${short} ${subject}\n  ${problem}`);
    }
  }

  const prTitle = process.env["PR_TITLE"];
  let titleFailed = false;
  if (prTitle !== undefined && prTitle !== "") {
    const problems = commitProblems(prTitle.trimEnd().split("\n"), false);
    if (problems.length > 0) {
      titleFailed = true;
      for (const problem of problems) {
        if (annotate) console.log(`::error title=Pull request title::${escape(`${prTitle} — ${problem}`)}`);
        else console.error(`PR title: ${prTitle}\n  ${problem}`);
      }
    }
  }

  if (failed > 0 || titleFailed) {
    const parts: string[] = [];
    if (failed > 0) parts.push(`${failed} of ${checked} checked commit(s)`);
    if (titleFailed) parts.push("the pull request title");
    console.error(
      `Commit messages: ${parts.join(" and ")} break the rules: one Conventional Commits subject line, no body, no trailers.`,
    );
    process.exitCode = 1;
  } else {
    const extra = prTitle ? " and the pull request title" : "";
    console.log(`Commit messages: ${checked} checked${extra}, all follow the rules.`);
  }
}
