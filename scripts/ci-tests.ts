// The merge group, main and manual runs use the entire configured suite. PRs can narrow two
// boundaries with no runtime consumers outside them: individual test files and the relay Worker.
// Shared sources, migrations, scripts, fixtures, configuration, lockfiles, renames and deletions
// all run everything. A new boundary needs an audit of runtime reads as well as static imports.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const testFile = /^(?:apps\/[\w-]+|packages\/(?:adapters\/)?[\w-]+|scripts)\/test\/[\w./-]+\.test\.ts$/;

export const selectedTests = (diff: string): string[] => {
  const filters = new Set<string>();
  const fields = diff.split("\0");
  if (fields.pop() !== "" || fields.length % 2 !== 0) return [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const path = fields[index + 1] ?? "";
    if (status !== "A" && status !== "M") return [];
    if (testFile.test(path)) filters.add(path);
    else if (/^apps\/relay\/src\/[\w./-]+\.ts$/.test(path)) filters.add("apps/relay/test/");
    else return [];
  }
  return [...filters].sort();
};

if (import.meta.main) {
  if (process.argv[2] === "plan") {
    const base = process.env["BASE"] ?? "";
    const head = process.env["HEAD"] ?? "";
    const filters =
      process.env["GITHUB_EVENT_NAME"] === "pull_request"
        ? selectedTests(
            execFileSync("git", ["diff", "--no-renames", "--name-status", "-z", `${base}...${head}`], {
              encoding: "utf8",
            }),
          )
        : [];
    console.log(filters.length ? `PR test filters: ${filters.join(", ")}` : "Running the full test suite.");
    appendFileSync(process.env["GITHUB_OUTPUT"]!, `tests=${JSON.stringify(filters)}\n`);
  } else {
    const filters: string[] =
      process.env["GITHUB_EVENT_NAME"] === "pull_request"
        ? JSON.parse(process.env["TEST_FILTERS"] || "[]")
        : [];
    const run = spawnSync("bun", ["run", "test", "--run", ...filters], { stdio: "inherit" });
    if (run.error) throw run.error;
    process.exitCode = run.status ?? 1;
  }
}
