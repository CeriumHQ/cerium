import type { AgentId, AgentInfo, ThreadId, ThreadInfo } from "@cerium/protocol";
import type { SpendEvent } from "@cerium/store";
import { assert, describe, it } from "@effect/vitest";

import { spendReport } from "../src/spend.ts";

const thread = (id: string, title: string): ThreadInfo => ({
  id: id as ThreadId,
  title,
  mode: "work",
  createdAt: 1,
  updatedAt: 1,
});

const agent = (id: string, threadId: string, provider: AgentInfo["provider"], model: string): AgentInfo => ({
  id: id as AgentId,
  threadId: threadId as ThreadId,
  role: id === "lead" ? "lead" : "worker",
  provider,
  model,
  access: "ask",
  state: "idle",
  createdAt: 1,
  updatedAt: 1,
});

const usage = (
  agentId: string,
  threadId: string,
  at: number,
  counts: Partial<SpendEvent> = { inputTokens: 100, outputTokens: 10 },
): SpendEvent => ({
  agentId: agentId as AgentId,
  threadId: threadId as ThreadId,
  at,
  tag: "UsageReported",
  ...counts,
});

const mark = (
  agentId: string,
  tag: "SessionStarted" | "ModelChanged" | "TurnInput",
  at: number,
  model?: string,
): SpendEvent => ({
  agentId: agentId as AgentId,
  threadId: "t1" as ThreadId,
  at,
  tag,
  ...(model === undefined ? {} : { model }),
});

const agents = [
  agent("lead", "t1", "claude", "claude-sonnet"),
  agent("helper", "t1", "codex", "gpt"),
  agent("solo", "t2", "opencode", "free-model"),
];
const threads = [thread("t1", "Fix the build"), thread("t2", "Ask a question")];
const edges = [0, 100, 200, 300];

describe("spendReport", () => {
  it("keeps historical usage on its session's provider after a cross-provider handoff", () => {
    const report = spendReport({
      agents: [agent("lead", "t1", "codex", "gpt")],
      threads,
      edges,
      events: [
        { ...mark("lead", "SessionStarted", 1, "claude-sonnet"), provider: "claude" },
        usage("lead", "t1", 10),
        usage("lead", "t1", 15, { provider: "opencode", model: "helper", inputTokens: 1 }),
        usage("lead", "t1", 20),
        { ...mark("lead", "SessionStarted", 30, "gpt"), provider: "codex" },
        usage("lead", "t1", 40),
      ],
    });
    assert.deepStrictEqual(
      report.models.map(({ provider, model, turns }) => [provider, model, turns]),
      [
        ["claude", "claude-sonnet", 2],
        ["codex", "gpt", 1],
        ["opencode", "helper", 1],
      ],
    );
  });

  it("sums tokens and reported cost, and counts a turn without a cost as unpriced", () => {
    const report = spendReport({
      agents,
      threads,
      edges,
      events: [
        usage("lead", "t1", 10, { inputTokens: 100, outputTokens: 10, cachedInputTokens: 50, costUsd: 0.25 }),
        usage("lead", "t1", 120, { inputTokens: 200, outputTokens: 20, costUsd: 0.5 }),
        usage("helper", "t1", 130, { inputTokens: 40, outputTokens: 4, cachedInputTokens: 30 }),
      ],
    });
    assert.deepStrictEqual(report.totals, {
      inputTokens: 340,
      outputTokens: 34,
      cachedInputTokens: 80,
      turns: 3,
      pricedTurns: 2,
      costUsd: 0.75,
    });
    assert.deepStrictEqual(
      report.providers.map(({ provider, turns, pricedTurns }) => ({ provider, turns, pricedTurns })),
      [
        { provider: "claude", turns: 2, pricedTurns: 2 },
        { provider: "codex", turns: 1, pricedTurns: 0 },
      ],
    );
  });

  it("cuts time at the edges and leaves out what falls outside them", () => {
    const report = spendReport({
      agents,
      threads,
      edges,
      events: [
        usage("lead", "t1", 99),
        usage("lead", "t1", 100),
        usage("lead", "t1", 299),
        usage("lead", "t1", 300),
        usage("lead", "t1", 5_000),
      ],
    });
    assert.deepStrictEqual(
      report.buckets.map(({ start, turns }) => [start, turns]),
      [
        [0, 1],
        [100, 1],
        [200, 1],
      ],
    );
    assert.strictEqual(report.totals.turns, 3);
  });

  it("puts each turn on the model it ran, applying a switch from the next turn", () => {
    const report = spendReport({
      agents: [agent("lead", "t1", "claude", "claude-opus")],
      threads,
      edges,
      events: [
        mark("lead", "SessionStarted", 1, "claude-sonnet"),
        mark("lead", "TurnInput", 2),
        usage("lead", "t1", 10),
        // Picked while the next turn runs: that turn still runs on sonnet.
        mark("lead", "TurnInput", 20),
        mark("lead", "ModelChanged", 25, "claude-opus"),
        usage("lead", "t1", 30),
        mark("lead", "TurnInput", 40),
        usage("lead", "t1", 50),
      ],
    });
    assert.deepStrictEqual(
      report.models.map(({ model, turns }) => [model, turns]),
      [
        ["claude-sonnet", 2],
        ["claude-opus", 1],
      ],
    );
  });

  it("falls back to the agent's model when its events never name one", () => {
    const report = spendReport({ agents, threads, edges, events: [usage("solo", "t2", 10)] });
    assert.deepStrictEqual(
      report.models.map(({ provider, model }) => `${provider}/${model}`),
      ["opencode/free-model"],
    );
  });

  it("lists threads and agents biggest first, and skips turns that reported nothing", () => {
    const report = spendReport({
      agents,
      threads,
      edges,
      events: [
        usage("solo", "t2", 10, { inputTokens: 1_000, outputTokens: 100 }),
        usage("lead", "t1", 20, { inputTokens: 10, outputTokens: 1 }),
        usage("helper", "t1", 30, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }),
        usage("ghost", "t1", 40),
      ],
    });
    assert.deepStrictEqual(
      report.threads.map(({ title, turns }) => [title, turns]),
      [
        ["Ask a question", 1],
        ["Fix the build", 1],
      ],
    );
    assert.deepStrictEqual(
      report.agents.map(({ agentId, role, title }) => [agentId, role, title]),
      [
        ["solo", "worker", "Ask a question"],
        ["lead", "lead", "Fix the build"],
      ],
    );
  });

  it("names the model an agent ran most", () => {
    const report = spendReport({
      agents: [agent("lead", "t1", "claude", "claude-opus")],
      threads,
      edges,
      events: [
        mark("lead", "SessionStarted", 1, "claude-sonnet"),
        usage("lead", "t1", 10, { inputTokens: 900, outputTokens: 100 }),
        mark("lead", "ModelChanged", 15, "claude-opus"),
        mark("lead", "TurnInput", 16),
        usage("lead", "t1", 20, { inputTokens: 10, outputTokens: 1 }),
      ],
    });
    assert.deepStrictEqual(
      report.agents.map(({ model }) => model),
      ["claude-sonnet"],
    );
  });
});

it("attributes helper usage to its actual provider/model without changing the lead's model", () => {
  const report = spendReport({
    agents,
    threads,
    edges,
    events: [
      mark("lead", "SessionStarted", 1, "claude-sonnet"),
      usage("lead", "t1", 10, { provider: "codex", model: "tiny", inputTokens: 50, outputTokens: 5 }),
      usage("lead", "t1", 20, { inputTokens: 100, outputTokens: 10 }),
      usage("lead", "t1", 30, {
        provider: "opencode",
        model: "unmetered",
        inputTokens: 0,
        outputTokens: 0,
        unreported: true,
      }),
    ],
  });
  assert.deepInclude(report.models, {
    provider: "codex",
    model: "tiny",
    inputTokens: 50,
    outputTokens: 5,
    cachedInputTokens: 0,
    turns: 1,
    pricedTurns: 0,
    costUsd: 0,
  });
  assert.strictEqual(report.models.find((row) => row.model === "claude-sonnet")?.inputTokens, 100);
  assert.strictEqual(report.providers.find((row) => row.provider === "opencode")?.turns, 1);
});
