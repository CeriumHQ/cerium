import type { PushRecord } from "@cerium/rpc";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checksOf,
  ciNote,
  failureNote,
  finishHook,
  logTail,
  NO_PROGRESS,
  outcomeNote,
  pushOutcome,
  readLine,
  rollup,
  runsOf,
  simulatedCi,
  stateOf,
  tailOf,
  type PushProgress,
} from "../src/pushModel.ts";

const read = (lines: ReadonlyArray<string>, from: PushProgress = NO_PROGRESS) =>
  lines.reduce((progress, line, index) => readLine(progress, line, 1_000 + index), from);

describe("readLine", () => {
  it("follows the hook's steps by their start and result lines", () => {
    const progress = read([
      "> Commit messages",
      "all good",
      "< Commit messages: passed",
      "> Verify",
      "lint…",
    ]);
    expect(progress.sending).toBe(false);
    expect(progress.hook.map((step) => [step.label, step.state])).toEqual([
      ["Commit messages", "passed"],
      ["Verify", "running"],
    ]);
  });

  it("ends a step that never said how when the next one starts", () => {
    const progress = read(["> One", "> Two"]);
    expect(progress.hook.map((step) => step.state)).toEqual(["done", "running"]);
  });

  it("passes the running steps once git talks to the remote, and reads no steps after", () => {
    const progress = read(["> Verify", "To github.com:o/r.git", "> not a step"]);
    expect(progress.sending).toBe(true);
    expect(progress.hook).toMatchObject([{ label: "Verify", state: "passed" }]);
  });

  it("doesn't take git's complaint after a failed hook for sending", () => {
    const progress = read(["> Verify", "error: failed to push some refs to 'github.com:o/r.git'"]);
    expect(progress.sending).toBe(false);
  });
});

describe("finishHook", () => {
  it("fails the step still running, or the last one when none said", () => {
    const running = read(["> A", "< A: passed", "> B"]).hook;
    expect(finishHook(running, false, 9).map((step) => step.state)).toEqual(["passed", "failed"]);
    const quiet = read(["> A", "> B"]).hook;
    expect(finishHook(finishHook(quiet, false, 9), false, 9).map((step) => step.state)).toEqual([
      "done",
      "failed",
    ]);
  });

  it("passes every step that didn't fail when the push went ahead", () => {
    expect(finishHook(read(["> A", "> B"]).hook, true, 9).map((step) => step.state)).toEqual([
      "passed",
      "passed",
    ]);
  });
});

describe("pushOutcome", () => {
  it("tells a rejection, a hook's failure and git's own apart", () => {
    expect(pushOutcome(0, "To x\n   a1b2c3d..e4f5a6b  main -> main", true)).toEqual({ stage: "pushed" });
    expect(pushOutcome(1, " ! [rejected]        main -> main (fetch first)", true).stage).toBe("rejected");
    expect(pushOutcome(1, "1 test failed\nerror: failed to push some refs to 'x'", false)).toEqual({
      stage: "failed",
      message: "The pre-push checks failed, so nothing was pushed.",
    });
    expect(pushOutcome(128, "fatal: Could not resolve host: github.com", false).message).toBe(
      "Can't reach the remote. Check your connection and try again.",
    );
  });
});

describe("tailOf", () => {
  it("keeps the end, cut at a line", () => {
    expect(tailOf("short", 10)).toBe("short");
    expect(tailOf("first line\nsecond\nthird", 14)).toBe("second\nthird");
  });
});

describe("GitHub's runs and jobs", () => {
  it("reads runs oldest first and their jobs as checks", () => {
    const runs = runsOf({
      workflow_runs: [
        {
          id: 2,
          name: "Pages",
          run_attempt: 1,
          html_url: "u2",
          status: "in_progress",
          created_at: "2026-10-26T10:01:00Z",
        },
        {
          id: 1,
          name: "CI",
          run_number: 7,
          run_attempt: 2,
          html_url: "u1",
          status: "completed",
          conclusion: "failure",
          created_at: "2026-10-26T10:00:00Z",
        },
        { name: "no id" },
      ],
    });
    expect(runs.map((run) => [run.id, run.name, run.state, run.attempt])).toEqual([
      ["1", "CI", "failed", 2],
      ["2", "Pages", "running", 1],
    ]);
    const checks = checksOf("1", {
      jobs: [
        {
          id: 11,
          name: "Test (Windows)",
          status: "completed",
          conclusion: "failure",
          started_at: "2026-10-26T10:00:10Z",
          completed_at: "2026-10-26T10:09:40Z",
          html_url: "j11",
          steps: [
            { name: "Install", conclusion: "success" },
            { name: "Test", conclusion: "failure" },
          ],
        },
        { id: 12, name: "Publish", status: "queued", started_at: "2026-10-26T10:00:10Z" },
      ],
    });
    expect(checks).toEqual([
      {
        id: "11",
        name: "Test (Windows)",
        state: "failed",
        runId: "1",
        startedAt: Date.parse("2026-10-26T10:00:10Z"),
        completedAt: Date.parse("2026-10-26T10:09:40Z"),
        url: "j11",
        failedStep: "Test",
      },
      { id: "12", name: "Publish", state: "queued", runId: "1" },
    ]);
  });

  it("rolls the runs and checks up into one state", () => {
    expect(stateOf("completed", "timed_out")).toBe("failed");
    expect(stateOf("completed", "skipped")).toBe("skipped");
    const run = { id: "1", name: "CI", attempt: 1, url: "u" } as const;
    const check = { id: "a", name: "A", runId: "1" } as const;
    expect(rollup([], [])).toBe("waiting");
    expect(rollup([{ ...run, state: "running" }], [{ ...check, state: "passed" }])).toBe("running");
    expect(rollup([{ ...run, state: "failed" }], [{ ...check, state: "failed" }])).toBe("failed");
    expect(rollup([{ ...run, state: "passed" }], [{ ...check, state: "skipped" }])).toBe("passed");
    expect(rollup([{ ...run, state: "cancelled" }], [{ ...check, state: "cancelled" }])).toBe("cancelled");
  });
});

describe("logTail", () => {
  it("keeps the lines up to the error, without timestamps, markers or the cleanup", () => {
    const log = [
      "2026-10-26T10:00:00.1234567Z ##[group]Run bun run test",
      "2026-10-26T10:00:01.1234567Z ✓ 211 passed",
      "2026-10-26T10:00:02.1234567Z × folds an older push",
      "2026-10-26T10:00:03.1234567Z ##[endgroup]",
      "2026-10-26T10:00:04.1234567Z ##[error]Expected 'checking' to be 'pushed'",
      "2026-10-26T10:00:05.1234567Z ##[error]Process completed with exit code 1.",
      "2026-10-26T10:00:06.1234567Z Post job cleanup.",
      "2026-10-26T10:00:07.1234567Z git version 2.47",
    ].join("\n");
    expect(logTail(log)).toEqual({
      log: [
        "Run bun run test",
        "✓ 211 passed",
        "× folds an older push",
        "Error: Expected 'checking' to be 'pushed'",
        "Error: Process completed with exit code 1.",
      ].join("\n"),
      summary: "Expected 'checking' to be 'pushed'",
    });
    expect(
      logTail(
        [
          "Run bun test",
          "      Tests  1 failed | 212 passed (213)",
          "##[error]Process completed with exit code 1.",
        ].join("\n"),
      ).summary,
    ).toBe("Tests 1 failed | 212 passed (213)");
    expect(logTail(Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n"), 3).log).toBe(
      "line 197\nline 198\nline 199",
    );
  });
});

const push = (change: Partial<PushRecord> = {}): PushRecord => ({
  id: "push_1",
  threadId: "thr_1" as PushRecord["threadId"],
  agentId: "agt_1" as PushRecord["agentId"],
  cwd: "/repo",
  remote: "origin",
  branch: "main",
  createdAt: 0,
  updatedAt: 0,
  stage: "pushed",
  hook: [],
  output: "",
  commits: [{ sha: "a41c9e2", subject: "fix: it" }],
  head: "a41c9e2ffffffff",
  ...change,
});

describe("what the agent is told", () => {
  it("says how the push went", () => {
    expect(outcomeNote(push())).toMatch(
      /^Pushed 1 commit to origin\/main \(a41c9e2\)\. The CI result reaches you/,
    );
    expect(outcomeNote(push({ stage: "rejected", message: "The remote moved." }))).toBe(
      "The push to origin/main was rejected: The remote moved. Don't force push.",
    );
    const failed = outcomeNote(
      push({
        stage: "failed",
        message: "The pre-push checks failed.",
        hook: [{ label: "Verify", state: "failed", startedAt: 0 }],
        output: "1 failed\n",
      }),
    );
    expect(failed).toContain("Failed: Verify.");
    expect(failed).toContain("```\n1 failed\n```");
  });

  it("gives the failed checks with their logs, and a line when CI passed", () => {
    const ci = {
      runs: [{ id: "1", name: "CI", attempt: 1, url: "run-url", state: "failed" as const }],
      checks: [
        { id: "a", name: "Lint", runId: "1", state: "passed" as const },
        { id: "b", name: "Test (Windows)", runId: "1", state: "failed" as const, failedStep: "Test" },
      ],
      failures: [
        {
          checkId: "b",
          name: "Test (Windows)",
          step: "Test",
          summary: "1 failed",
          log: "× it",
          url: "job-url",
        },
      ],
    };
    const failed = push({ ci: { ...ci, state: "failed" } });
    expect(ciNote(failed)).toBe(failureNote(failed));
    expect(failureNote(failed)).toBe(
      [
        "CI failed for your push to origin/main (a41c9e2): Test (Windows) failed.",
        'Test (Windows), at step "Test": 1 failed\n```\n× it\n```\njob-url',
        "Fix what failed and push again.",
      ].join("\n\n"),
    );
    expect(ciNote(push({ ci: { ...ci, state: "passed" } }))).toBe(
      "CI for your push to origin/main (a41c9e2) passed: 1 check.",
    );
    expect(ciNote(push({ ci: { ...ci, state: "running" } }))).toBeUndefined();
  });
});

describe("simulatedCi", () => {
  it("queues, runs and ends its checks over time, failing one when asked", () => {
    expect(simulatedCi(1_000, "pass", 0).runs).toEqual([]);
    const running = simulatedCi(5_000, "fail", 0);
    expect(rollup(running.runs, running.checks)).toBe("running");
    expect(running.checks.some((check) => check.state === "waiting")).toBe(true);
    const failed = simulatedCi(60_000, "fail", 0);
    expect(rollup(failed.runs, failed.checks)).toBe("failed");
    expect(failed.checks.filter((check) => check.state === "failed").map((check) => check.name)).toEqual([
      "Tests (Linux)",
    ]);
    const passed = simulatedCi(60_000, "pass", 0);
    expect(rollup(passed.runs, passed.checks)).toBe("passed");
  });
});

// Git's real output, through a pre-push hook that prints its steps as Cerium's own does.

const scratch: Array<string> = [];
afterAll(() => {
  for (const folder of scratch) rmSync(folder, { recursive: true, force: true });
});

const git = (cwd: string, ...args: Array<string>) => {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
  return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
};

const HOOK = [
  "#!/bin/sh",
  'echo "> Commit messages"',
  'echo "< Commit messages: passed"',
  'echo "> Verify"',
  'if [ -f fail-hook ]; then echo "1 test failed"; echo "< Verify: failed"; exit 1; fi',
  'echo "< Verify: passed"',
  "",
].join("\n");

const repository = () => {
  const root = mkdtempSync(join(tmpdir(), "cerium-push-"));
  scratch.push(root);
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "init", "--initial-branch=main", work);
  git(work, "remote", "add", "origin", remote);
  writeFileSync(join(work, "a.txt"), "a\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-m", "first");
  writeFileSync(join(work, ".git", "hooks", "pre-push"), HOOK, { mode: 0o755 });
  return { root, remote, work };
};

const pushed = (cwd: string) => {
  const { code, output } = git(cwd, "push", "origin", "refs/heads/main:refs/heads/main");
  const progress = read(output.replaceAll("\r", "").split("\n"));
  const outcome = pushOutcome(code, output, progress.sending);
  const hook = finishHook(progress.hook, outcome.stage !== "failed" || progress.sending, 0);
  return { outcome, hook: hook.map((step) => [step.label, step.state]) };
};

describe("a real push", () => {
  it("reads the hook's steps and how the push went", { timeout: 30_000 }, () => {
    const { work } = repository();
    expect(pushed(work)).toEqual({
      outcome: { stage: "pushed" },
      hook: [
        ["Commit messages", "passed"],
        ["Verify", "passed"],
      ],
    });
  });

  it("fails on the hook's failing step", { timeout: 30_000 }, () => {
    const { work } = repository();
    writeFileSync(join(work, "fail-hook"), "");
    expect(pushed(work)).toEqual({
      outcome: { stage: "failed", message: "The pre-push checks failed, so nothing was pushed." },
      hook: [
        ["Commit messages", "passed"],
        ["Verify", "failed"],
      ],
    });
  });

  it("is rejected when the remote moved on", { timeout: 30_000 }, () => {
    const { root, remote, work } = repository();
    git(work, "push", "--no-verify", "origin", "main");
    const other = join(root, "other");
    git(root, "clone", remote, other);
    writeFileSync(join(other, "b.txt"), "b\n");
    git(other, "add", "b.txt");
    git(other, "commit", "-m", "elsewhere");
    git(other, "push", "--no-verify", "origin", "main");
    writeFileSync(join(work, "c.txt"), "c\n");
    git(work, "add", "c.txt");
    git(work, "commit", "-m", "here");
    expect(pushed(work).outcome.stage).toBe("rejected");
  });
});
