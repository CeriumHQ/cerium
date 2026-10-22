// Checks commit messages against the repository's rules: one Conventional Commits subject
// line (`type(scope): summary`) with no body and no trailers. CI runs it on every push and pull
// request.
//
// Usage: node scripts/check-commits.ts <base> [head]
// Checks base..head, or only head when base is empty, all zeros (a new branch) or not in the history.
// Merge commits and commits authored by bots (Dependabot) are skipped.

import { execFileSync } from "node:child_process";

const [base = "", head = "HEAD"] = process.argv.slice(2);

const types = ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"];
const subjectPattern = new RegExp(`^(${types.join("|")})(\\([a-z0-9-]+(,[a-z0-9-]+)*\\))?!?: \\S`);
const botAuthor = /\[bot\]@users\.noreply\.github\.com$/;

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
const commits = git("log", "--format=%H%x00%P%x00%ae%x00%B%x1e", ...range)
  .split("\x1e")
  .map((record) => record.replace(/^\n/, ""))
  .filter((record) => record !== "")
  .map((record) => {
    const [hash = "", parents = "", email = "", message = ""] = record.split("\0");
    return { hash, parents: parents.split(" ").filter(Boolean), email, lines: message.trimEnd().split("\n") };
  });

const annotate = process.env["GITHUB_ACTIONS"] === "true";
const escape = (text: string): string =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

let checked = 0;
let failed = 0;
for (const { hash, parents, email, lines } of commits) {
  if (parents.length > 1 || botAuthor.test(email)) continue;
  checked++;
  const [subject = "", ...rest] = lines;
  const problems: string[] = [];
  if (!subjectPattern.test(subject)) {
    problems.push(`the subject must read \`type(scope): summary\` with a type from: ${types.join(", ")}`);
  }
  const extra = rest.find((line) => line.trim() !== "");
  if (extra !== undefined) {
    problems.push(`only the subject line is allowed, with no body or trailers (found "${extra.trim()}")`);
  }
  if (problems.length === 0) continue;
  failed++;
  const short = hash.slice(0, 7);
  for (const problem of problems) {
    if (annotate) console.log(`::error title=Commit ${short}::${escape(`${subject} — ${problem}`)}`);
    else console.error(`${short} ${subject}\n  ${problem}`);
  }
}

if (failed > 0) {
  console.error(
    `Commit messages: ${failed} of ${checked} checked break the rules: one Conventional Commits subject line, no body, no trailers.`,
  );
  process.exitCode = 1;
} else {
  console.log(`Commit messages: ${checked} checked, all follow the rules.`);
}
