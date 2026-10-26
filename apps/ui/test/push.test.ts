import type { PushCheck, PushRecord } from "@cerium/rpc";
import { describe, expect, it } from "@effect/vitest";

import { layout } from "../src/features/transcript/layout.ts";
import {
  checkStatus,
  duration,
  foldedLine,
  headline,
  pushOf,
  sentLine,
  supersededBy,
} from "../src/features/transcript/push.ts";
import type { ToolBlock } from "../src/features/transcript/tools.ts";

const NOW = 1_000_000_000;

type Change = { [K in keyof PushRecord]?: PushRecord[K] | undefined };

const push = (change: Change = {}): PushRecord => ({
  id: "push_1",
  threadId: "thr_1" as PushRecord["threadId"],
  agentId: "agt_1" as PushRecord["agentId"],
  cwd: "/repo",
  remote: "origin",
  branch: "main",
  createdAt: NOW - 60_000,
  updatedAt: NOW,
  stage: "pushed",
  hook: [{ label: "Verify", state: "passed", startedAt: NOW - 60_000, endedAt: NOW - 30_000 }],
  output: "",
  commits: [
    { sha: "a".repeat(40), subject: "fix: one" },
    { sha: "b".repeat(40), subject: "fix: two" },
    { sha: "c".repeat(40), subject: "fix: three" },
  ],
  head: "a".repeat(40),
  repository: "cerium/cerium",
  ...(change as Partial<PushRecord>),
});

const call = (change: Partial<ToolBlock> = {}): ToolBlock => ({
  kind: "tool",
  id: "tool:1",
  toolName: "mcp__cerium__push",
  input: {},
  status: "running",
  changedFiles: [],
  ...change,
});

const check = (state: PushCheck["state"], name = "Test"): PushCheck => ({
  id: name,
  name,
  runId: "1",
  state,
  startedAt: NOW - 120_000,
  ...(state === "passed" || state === "failed" ? { completedAt: NOW - 30_000 } : {}),
});

const ci = (
  state: NonNullable<PushRecord["ci"]>["state"],
  checks: NonNullable<PushRecord["ci"]>["checks"],
) => ({
  state,
  runs: [{ id: "1", name: "CI", attempt: 1, url: "https://github.com/run/1", state: "running" as const }],
  checks,
  failures: [],
});

describe("duration", () => {
  it("says a duration as people do", () => {
    expect(duration(18_000)).toBe("18s");
    expect(duration(570_000)).toBe("9m 30s");
    expect(duration(362_000)).toBe("6m 02s");
    expect(duration(660_000, true)).toBe("11m");
    expect(duration(3_900_000)).toBe("1h 5m");
  });
});

describe("headline", () => {
  it("says how far GitHub's checks are", () => {
    const running = push({
      ci: ci("running", [check("passed", "Lint"), check("running", "Test"), check("waiting", "Publish")]),
    });
    expect(headline(running, NOW)).toEqual({
      tone: "running",
      title: "GitHub is checking your 3 changes",
      meta: "1 of 3 done · 2m",
    });
    expect(
      headline(push({ ci: ci("failed", [check("passed", "Lint"), check("failed", "Test")]) }), NOW),
    ).toMatchObject({
      tone: "failed",
      title: "1 of 2 checks failed",
    });
    expect(
      headline(push({ ci: { ...ci("passed", [check("passed")]), finishedAt: NOW } }), NOW),
    ).toMatchObject({
      tone: "passed",
      title: "The check passed",
    });
  });

  it("says what happened before GitHub, or why there are no checks", () => {
    expect(headline(push({ stage: "checking", ci: undefined }), NOW).title).toBe(
      "Checking your changes on your computer",
    );
    expect(
      headline(push({ stage: "failed", hook: [{ label: "Verify", state: "failed", startedAt: 0 }] }), NOW)
        .title,
    ).toBe("The checks on your computer failed");
    expect(headline(push({ stage: "rejected" }), NOW).title).toBe("The push was turned away");
    expect(headline(push({ commits: [] }), NOW).title).toBe("Nothing new to send");
    expect(
      headline(
        push({
          repository: undefined,
          commits: [push().commits[0]!],
          ci: { ...ci("unavailable", []), note: "Not on GitHub." },
        }),
        NOW,
      ),
    ).toEqual({ tone: "passed", title: "Sent your change to origin", note: "Not on GitHub." });
  });
});

describe("rows", () => {
  it("says each check's state and time", () => {
    expect(checkStatus(check("passed"), NOW)).toBe("Passed · 1m 30s");
    expect(checkStatus(check("running"), NOW)).toBe("Running · 2m");
    expect(checkStatus(check("waiting"), NOW)).toBe("Waiting for the others");
    expect(sentLine(push())).toBe("Checked on your computer first, then sent to GitHub");
    expect(sentLine(push({ hook: [], repository: undefined }))).toBe("Sent to origin");
  });
});

describe("pushOf", () => {
  it("finds the push a call's answer names, or the one under way while it waits", () => {
    const first = push({ id: "push_1", createdAt: NOW - 600_000 });
    const second = push({ id: "push_2", stage: "checking", createdAt: NOW - 1_000 });
    const answered = call({
      status: "done",
      output: JSON.stringify({ status: "pushed", pushId: "push_1", note: "" }),
    });
    expect(pushOf(answered, [first, second], NOW)?.id).toBe("push_1");
    expect(pushOf(call(), [first, second], NOW)?.id).toBe("push_2");
    const denied = call({ status: "done", output: JSON.stringify({ status: "denied", note: "No." }) });
    expect(pushOf(denied, [first, second], NOW)).toBeUndefined();
    expect(supersededBy(first, [first, second])).toBe(true);
    expect(supersededBy(second, [first, second])).toBe(false);
    expect(foldedLine(push({ ci: ci("passed", [check("passed")]) }), NOW)).toBe(
      "Pushed 3 changes · The check passed",
    );
  });
});

describe("layout", () => {
  it("shows a push as its own item, outside the run of tool calls around it", () => {
    const read: ToolBlock = { ...call(), id: "tool:0", toolName: "Read", status: "done" };
    const items = layout([read, call({ status: "done" }), { ...read, id: "tool:2" }]);
    expect(items.map((item) => item.kind)).toEqual(["header", "run", "push", "run"]);
    const refused = layout([call({ status: "error", output: "Your last push is still running." })]);
    expect(refused.map((item) => item.kind)).toEqual(["header", "run"]);
  });
});
