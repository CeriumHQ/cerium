import type { AgentSummary } from "../features/agents/model.ts";

// The agents of the "Fix flaky auth test" fixture thread, matching transcriptFixture.

const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000;

export const agentsFixture: ReadonlyArray<AgentSummary> = [
  {
    id: "agt_lead",
    role: "lead",
    provider: "claude",
    model: "Opus 5.5",
    effort: "high",
    access: "ask",
    state: "running",
    awaitingApproval: true,
    usage: { inputTokens: 78_904, outputTokens: 2_210, costUsd: 0.19 },
    lastMessage: "Now I'll run the auth tests 20 times to confirm the flake is gone.",
    startedAt: minutesAgo(6),
  },
  {
    id: "agt_scout1",
    parentId: "agt_lead",
    role: "pr-scout",
    provider: "muse",
    model: "Muse Spark 1.3",
    effort: "low",
    access: "readOnly",
    state: "idle",
    awaitingApproval: false,
    usage: { inputTokens: 14_220, outputTokens: 640, costUsd: 0.02 },
    lastMessage:
      "Two open PRs touch src/auth: #412 (login form styling) and #418 (OAuth scopes). Neither changes session.ts.",
    startedAt: minutesAgo(5),
  },
  {
    id: "agt_scout2",
    parentId: "agt_lead",
    role: "pr-reviewer",
    provider: "muse",
    model: "Muse Spark 1.3",
    effort: "low",
    access: "readOnly",
    state: "idle",
    awaitingApproval: false,
    usage: { inputTokens: 9_870, outputTokens: 410, costUsd: 0.01 },
    lastMessage: "#412 only edits LoginForm.tsx and its CSS module. No session handling changes.",
    startedAt: minutesAgo(5),
  },
];
