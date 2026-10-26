import type { AgentId, ThreadId } from "@cerium/protocol";
import type { PushRecord } from "@cerium/rpc";
import { assert, describe, it } from "@effect/vitest";

import { ciPrompt, runTitle, sameFolder, scheduleStep, withRun, KEPT_RUNS } from "../src/automationsModel.ts";

// Local times, so the tests hold in any time zone. 2026-10-26 is a Monday.
const at = (day: number, hours: number, minutes = 0) => new Date(2026, 9, day, hours, minutes).getTime();

describe("scheduleStep", () => {
  const daily = { _tag: "Daily", at: 9 * 60 } as const;

  it("waits until a time comes round after the one handled", () => {
    assert.deepStrictEqual(scheduleStep(daily, at(26, 9), at(26, 15)), { _tag: "Wait" });
  });

  it("runs a time noticed as it comes round", () => {
    assert.deepStrictEqual(scheduleStep(daily, at(25, 9), at(26, 9, 1)), {
      _tag: "Run",
      slot: at(26, 9),
      cause: "schedule",
    });
  });

  it("runs a missed time once while it's nearer than the next", () => {
    // Closed from Friday to Monday afternoon: one run, for Monday morning's time.
    assert.deepStrictEqual(scheduleStep(daily, at(23, 9), at(26, 14)), {
      _tag: "Run",
      slot: at(26, 9),
      cause: "missed",
    });
  });

  it("drops a missed time once the next is nearer", () => {
    // Yesterday's time, opened an hour before today's.
    assert.deepStrictEqual(scheduleStep(daily, at(24, 9), at(26, 8)), {
      _tag: "Drop",
      slot: at(25, 9),
      next: at(26, 9),
    });
  });

  it("treats a late hourly run the same way", () => {
    const hourly = { _tag: "Hourly", minute: 0 } as const;
    assert.strictEqual(scheduleStep(hourly, at(26, 9), at(26, 10, 20))._tag, "Run");
    assert.strictEqual(scheduleStep(hourly, at(26, 9), at(26, 10, 50))._tag, "Drop");
  });
});

const push: PushRecord = {
  id: "push-1",
  threadId: "thr_1" as ThreadId,
  agentId: "agt_1" as AgentId,
  cwd: "C:/code/app",
  remote: "origin",
  branch: "main",
  createdAt: 1,
  updatedAt: 2,
  stage: "pushed",
  hook: [],
  output: "",
  commits: [{ sha: "1a2b3c4d5e6f", subject: "fix: the thing" }],
  head: "1a2b3c4d5e6f",
  repository: "me/app",
  ci: {
    state: "failed",
    runs: [],
    checks: [],
    failures: [{ checkId: "1", name: "Tests", step: "Run tests", log: "1 failed", summary: "1 test failed" }],
  },
};

describe("runTitle", () => {
  it("names a scheduled run for when it ran and a CI run for its commit", () => {
    assert.match(runTitle("Morning triage", at(26, 9)), /^Morning triage · Oct 26, 9:00/);
    assert.strictEqual(runTitle("Fix CI", at(26, 9), push), "Fix CI · main 1a2b3c4");
  });

  it("fits a thread's title", () => {
    assert.isAtMost(runTitle("x".repeat(60), at(26, 9), { ...push, branch: "b".repeat(40) }).length, 80);
  });
});

describe("ciPrompt", () => {
  it("follows the prompt with what failed on which commit", () => {
    const text = ciPrompt("Find out why CI failed and fix it.", push, "Add the parser");
    assert.match(text, /^Find out why CI failed and fix it\.\n\n---\n\n/);
    assert.include(
      text,
      'CI failed on main at 1a2b3c4 in me/app, pushed to origin from the thread "Add the parser".',
    );
    assert.include(text, "- 1a2b3c4 fix: the thing");
    assert.include(text, 'Tests, at step "Run tests": 1 test failed\n```\n1 failed\n```');
  });
});

describe("withRun", () => {
  it("keeps the newest runs first, as many as are kept", () => {
    const runs = Array.from({ length: KEPT_RUNS }, (_, index) => ({
      id: `${index}`,
      at: index,
      cause: "manual" as const,
    }));
    const kept = withRun(runs, { id: "new", at: 99, cause: "schedule" });
    assert.strictEqual(kept.length, KEPT_RUNS);
    assert.strictEqual(kept[0]?.id, "new");
  });
});

describe("sameFolder", () => {
  it("ignores case and separators on Windows only", () => {
    assert.isTrue(sameFolder("C:\\Code\\App\\", "c:/code/app", "win32"));
    assert.isFalse(sameFolder("/code/App", "/code/app", "linux"));
  });
});
