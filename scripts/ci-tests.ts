// Main-bound PRs, merge groups, main pushes and manual runs use the full suite. Stacked PRs can narrow two
// boundaries with no runtime consumers outside them: individual test files and the relay Worker.
// Shared sources, migrations, scripts, fixtures, configuration, lockfiles, renames and deletions
// all run everything. A new boundary needs an audit of runtime reads as well as static imports.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

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

function canSelectTests() {
  const base = process.env["GITHUB_BASE_REF"];
  return process.env["GITHUB_EVENT_NAME"] === "pull_request" && !!base && base !== "main";
}

if (import.meta.main) {
  if (process.argv[2] === "plan") {
    const base = process.env["BASE"] ?? "";
    const head = process.env["HEAD"] ?? "";
    const filters = canSelectTests()
      ? selectedTests(
          execFileSync("git", ["diff", "--no-renames", "--name-status", "-z", `${base}...${head}`], {
            encoding: "utf8",
          }),
        )
      : [];
    console.log(filters.length ? `PR test filters: ${filters.join(", ")}` : "Running the full test suite.");
    appendFileSync(process.env["GITHUB_OUTPUT"]!, `tests=${JSON.stringify(filters)}\n`);
  } else {
    const filters: string[] = canSelectTests() ? JSON.parse(process.env["TEST_FILTERS"] || "[]") : [];
    const temp = process.env["RUNNER_TEMP"];
    const report = filters.length === 0 && temp ? join(temp, "vitest-results.json") : undefined;
    const reporters = report ? ["--reporter=default", "--reporter=json", `--outputFile.json=${report}`] : [];
    const run = spawnSync("bun", ["run", "test", "--run", ...reporters, ...filters], { stdio: "inherit" });
    if (run.error) throw run.error;
    process.exitCode = run.status ?? 1;
    if (run.status === 0 && report && temp) {
      const { testResults } = JSON.parse(readFileSync(report, "utf8")) as {
        testResults: { name: string; startTime: number; endTime: number }[];
      };
      const expected = new Set(
        execFileSync("git", ["ls-files", "-z", "*.test.ts"], { encoding: "utf8" })
          .split("\0")
          .filter(Boolean),
      );
      const timings: Record<string, number> = {};
      for (const result of testResults) {
        const file = relative(process.cwd(), result.name).split(sep).join("/");
        if (!expected.delete(file)) throw new Error(`Unexpected or duplicate test module: ${file}`);
        const ms = result.endTime - result.startTime;
        if (!Number.isFinite(ms) || ms < 0) throw new Error(`Invalid file duration for ${file}: ${ms}`);
        timings[file] = Math.ceil(ms);
      }
      if (expected.size) throw new Error(`Missing test modules: ${[...expected].join(", ")}`);
      console.log(`Verified all ${testResults.length} tracked test modules.`);
      writeFileSync(join(temp, "test-file-times.json"), JSON.stringify(timings, null, 2));
    }
  }
}
