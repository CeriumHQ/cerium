import { describe, expect, it } from "@effect/vitest";

import type { AgentEvent, AgentInfo } from "@cerium/protocol";

import { toAgentSummaries } from "../src/backend/view.ts";
import {
  agentMenuPlan,
  hasAgentMenu,
  requestQueue,
  stateLabel,
  statusCounts,
  stopAllScope,
  stopAllSummary,
  threadUsage,
} from "../src/features/agents/model.ts";
import type { AgentSummary } from "../src/features/agents/model.ts";

const agent = (state: AgentSummary["state"], parentId?: string) => ({
  state,
  ...(parentId ? { parentId } : {}),
});
const row = { card: false, canMessage: true };
const card = { card: true, canMessage: true };

describe("agentMenuPlan", () => {
  it("offers a working child interrupting and stopping, but no messaging", () => {
    expect(agentMenuPlan(agent("running", "lead"), row)).toEqual({
      show: false,
      message: false,
      interrupt: "enabled",
      stop: true,
    });
  });

  it("offers the lead a message too", () => {
    expect(agentMenuPlan(agent("idle"), row)).toEqual({
      show: false,
      message: true,
      interrupt: "disabled",
      stop: true,
    });
  });

  it("leaves out Message where it can't be done", () => {
    expect(agentMenuPlan(agent("idle"), { card: false, canMessage: false }).message).toBe(false);
  });

  it("treats a queued agent as working", () => {
    expect(agentMenuPlan(agent("queued", "lead"), row).interrupt).toBe("enabled");
  });

  it("gives an ended agent no menu on a row", () => {
    for (const state of ["stopped", "failed"] as const) {
      expect(hasAgentMenu(agentMenuPlan(agent(state, "lead"), row))).toBe(false);
      expect(hasAgentMenu(agentMenuPlan(agent(state), row))).toBe(false);
    }
  });

  it("keeps only 'Show in agents panel' on an ended agent's card", () => {
    expect(agentMenuPlan(agent("stopped", "lead"), card)).toEqual({
      show: true,
      message: false,
      interrupt: "hidden",
      stop: false,
    });
  });
});

const summary = (
  id: string,
  overrides: Partial<AgentSummary> & { parentId?: string } = {},
): AgentSummary => ({
  id,
  role: id,
  provider: "claude",
  model: "Opus 5.5",
  access: "auto",
  state: "idle",
  awaitingApproval: false,
  approvals: [],
  spawns: [],
  questions: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  todos: [],
  startedAt: 0,
  ...overrides,
});

const asking = (requestId: string, at: number) => ({
  requestId,
  toolName: "shell",
  summary: "Run a shell command",
  input: {},
  at,
});

describe("statusCounts", () => {
  it("counts the states that deserve a word, and leaves the rest out", () => {
    const agents = [
      summary("lead", { state: "running" }),
      summary("a", { parentId: "lead", state: "queued" }),
      summary("b", { parentId: "lead", state: "running", awaitingApproval: true }),
      summary("c", { parentId: "lead", state: "failed" }),
      summary("d", { parentId: "lead", state: "stopped" }),
      summary("e", { parentId: "lead", state: "idle" }),
    ];
    expect(statusCounts(agents)).toEqual([
      { state: "needsYou", count: 1 },
      { state: "running", count: 2 },
      { state: "failed", count: 1 },
    ]);
  });

  it("says nothing of a thread at rest", () => {
    expect(statusCounts([summary("lead"), summary("a", { parentId: "lead", state: "stopped" })])).toEqual([]);
  });
});

describe("stopAllScope", () => {
  it("counts the working agents and every request it would deny", () => {
    const agents = [
      summary("lead", { state: "running", approvals: [asking("p1", 1)] }),
      summary("a", { parentId: "lead", state: "queued" }),
      summary("b", { parentId: "lead", state: "idle", approvals: [asking("p2", 2), asking("p3", 3)] }),
      summary("c", { parentId: "lead", state: "stopped" }),
    ];
    expect(stopAllScope(agents)).toEqual({ agents: 2, approvals: 3 });
    expect(stopAllSummary(stopAllScope(agents))).toBe("2 working agents and 3 pending approvals");
  });

  it("names only the parts that apply, singular for one", () => {
    expect(stopAllSummary({ agents: 1, approvals: 0 })).toBe("1 working agent");
    expect(stopAllSummary({ agents: 0, approvals: 1 })).toBe("1 pending approval");
    expect(stopAllScope([summary("lead")])).toEqual({ agents: 0, approvals: 0 });
  });
});

describe("stateLabel", () => {
  it("calls a child that went idle done, and a lead idle", () => {
    expect(stateLabel(summary("a", { parentId: "lead" }))).toBe("Done");
    expect(stateLabel(summary("lead"))).toBe("Idle");
    expect(stateLabel(summary("a", { parentId: "lead", awaitingApproval: true }))).toBe("Needs you");
  });
});

describe("threadUsage", () => {
  const usage = (inputTokens: number, outputTokens: number, costUsd?: number) => ({
    inputTokens,
    outputTokens,
    ...(costUsd === undefined ? {} : { costUsd }),
  });

  it("adds up each provider's agents and sums the costs that were reported", () => {
    const result = threadUsage([
      summary("lead", { usage: usage(1000, 100, 2) }),
      summary("a", { parentId: "lead", usage: usage(500, 50, 0.5) }),
      summary("b", { parentId: "lead", provider: "codex", usage: usage(300, 30) }),
    ]);
    expect(result.providers).toEqual([
      { provider: "claude", inputTokens: 1500, outputTokens: 150, costUsd: 2.5 },
      { provider: "codex", inputTokens: 300, outputTokens: 30 },
    ]);
    expect(result.total).toBe(2.5);
    expect(result.partial).toBe(true);
  });

  it("leaves out providers that haven't counted anything", () => {
    const result = threadUsage([
      summary("lead", { usage: usage(10, 1, 0.1) }),
      summary("a", { parentId: "lead", provider: "muse" }),
    ]);
    expect(result.providers.map(({ provider }) => provider)).toEqual(["claude"]);
    expect(result.partial).toBe(false);
  });
});

describe("requestQueue", () => {
  it("orders what the agents wait on by when it was asked, the lead's spawn requests among them", () => {
    const queue = requestQueue([
      summary("lead", {
        awaitingApproval: true,
        spawns: [{ requestId: "s1", role: "r", provider: "codex", model: "m", at: 20 }],
      }),
      summary("a", { parentId: "lead", approvals: [asking("p2", 30), asking("p1", 10)] }),
      summary("b", { parentId: "lead", approvals: [asking("p3", 25)] }),
    ]);
    expect(queue.map((item) => item.key)).toEqual([
      "permission:p1",
      "spawn:s1",
      "permission:p3",
      "permission:p2",
    ]);
  });

  it("leaves the lead's own permission requests to the conversation", () => {
    const queue = requestQueue([summary("lead", { approvals: [asking("p1", 1)] })]);
    expect(queue).toEqual([]);
  });

  it("queues a child's questions among its requests, and leaves the lead's to the conversation", () => {
    const question = (requestId: string, at: number) => ({
      requestId,
      questions: [{ question: "Which one?", options: [], multiSelect: false, allowOther: true }],
      at,
    });
    const queue = requestQueue([
      summary("lead", { questions: [question("q0", 1)] }),
      summary("a", { parentId: "lead", approvals: [asking("p1", 10)], questions: [question("q1", 5)] }),
    ]);
    expect(queue.map((item) => item.key)).toEqual(["question:q1", "permission:p1"]);
  });
});

describe("toAgentSummaries", () => {
  const info = (id: string, parentId?: string, state: AgentInfo["state"] = "running") =>
    ({
      id,
      ...(parentId ? { parentId } : {}),
      threadId: "t",
      role: parentId ? id : "lead",
      provider: "claude",
      model: "claude-opus-5-5",
      access: "auto",
      state,
      createdAt: 0,
      updatedAt: 0,
    }) as unknown as AgentInfo;
  const event = (agentId: string, at: number, payload: Record<string, unknown>) =>
    ({ id: `${agentId}:${at}`, threadId: "t", agentId, sequence: at, at, payload }) as unknown as AgentEvent;

  it("keeps each agent's latest todo list whole, and why its plan changed", () => {
    const first = event("lead", 1, {
      _tag: "TodosUpdated",
      items: [
        { text: "Write", status: "inProgress" },
        { text: "Test", status: "pending" },
      ],
    });
    const second = event("lead", 2, {
      _tag: "TodosUpdated",
      items: [
        { text: "Write", status: "completed" },
        { text: "Test", status: "inProgress" },
      ],
      explanation: "Tests come next",
    });
    const other = event("child", 3, { _tag: "TodosUpdated", items: [{ text: "Look", status: "pending" }] });
    const [lead, child] = toAgentSummaries([info("lead"), info("child", "lead")], [first, second, other], []);
    expect(lead?.todos.map((each) => each.status)).toEqual(["completed", "inProgress"]);
    expect(lead?.todosNote).toBe("Tests come next");
    expect(child?.todos).toEqual([{ text: "Look", status: "pending" }]);
    expect(child?.todosNote).toBeUndefined();

    const cleared = event("lead", 4, { _tag: "TodosUpdated", items: [] });
    expect(toAgentSummaries([info("lead")], [first, cleared], [])[0]?.todos).toEqual([]);
  });

  it("keeps a lead's spawn request until it is answered, and what the agent would run with", () => {
    const asked = event("lead", 5, {
      _tag: "SpawnApprovalRequested",
      requestId: "s1",
      role: "profiler",
      provider: "codex",
      model: "gpt-x",
      effort: "high",
      access: "readOnly",
      prompt: "Profile it.",
    });
    const [lead] = toAgentSummaries([info("lead")], [asked], []);
    expect(lead?.spawns).toEqual([
      {
        requestId: "s1",
        role: "profiler",
        provider: "codex",
        model: "gpt-x",
        effort: "high",
        access: "readOnly",
        prompt: "Profile it.",
        at: 5,
      },
    ]);
    expect(lead?.awaitingApproval).toBe(true);

    const answered = event("lead", 6, { _tag: "SpawnApprovalResolved", requestId: "s1", decision: "deny" });
    const [after] = toAgentSummaries([info("lead")], [asked, answered], []);
    expect(after?.spawns).toEqual([]);
    expect(after?.awaitingApproval).toBe(false);
  });

  it("drops what an ended lead can no longer act on", () => {
    const asked = event("lead", 5, {
      _tag: "SpawnApprovalRequested",
      requestId: "s1",
      role: "profiler",
      provider: "codex",
      model: "gpt-x",
    });
    const [lead] = toAgentSummaries([info("lead", undefined, "stopped")], [asked], []);
    expect(lead?.spawns).toEqual([]);
  });

  it("keeps an agent's questions until they close, and counts them as waiting on the user", () => {
    const questions = [{ question: "Which one?", options: [], multiSelect: false, allowOther: true }];
    const asked = event("a", 5, { _tag: "QuestionAsked", requestId: "q1", questions });
    const [agent] = toAgentSummaries([info("a", "lead", "idle")], [asked], []);
    expect(agent?.questions).toEqual([{ requestId: "q1", questions, at: 5 }]);
    expect(agent?.awaitingApproval).toBe(true);

    const closed = event("a", 6, { _tag: "QuestionResolved", requestId: "q1", outcome: "dismissed" });
    const [after] = toAgentSummaries([info("a", "lead", "idle")], [asked, closed], []);
    expect(after?.questions).toEqual([]);
    expect(after?.awaitingApproval).toBe(false);
  });

  it("carries what a failed agent reported going wrong", () => {
    const failed = event("a", 3, {
      _tag: "AgentError",
      kind: "crash",
      message: "it crashed",
      retryable: false,
    });
    const [agent] = toAgentSummaries([info("a", "lead", "failed")], [failed], []);
    expect(agent?.error).toBe("it crashed");
  });
});
