import type { AgentEvent, AgentInfo } from "@cerium/protocol";
import type { ThreadOverview } from "@cerium/rpc";

import type { AgentSummary } from "../features/agents/model.ts";
import type { ThreadSummary } from "../features/threads/model.ts";

// Maps backend records onto the view models the components render.

const modelLabels: Record<string, string> = {
  opus: "Opus 5.5",
  "claude-opus-5-5": "Opus 5.5",
  sonnet: "Sonnet 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  haiku: "Haiku 5.5",
  "claude-haiku-5-5": "Haiku 5.5",
};

/** A model id or alias as people say it. */
export const modelLabel = (model: string) => modelLabels[model] ?? model;

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export const leadOf = (agents: ReadonlyArray<AgentInfo>) =>
  agents.find((agent) => agent.parentId === undefined);

export const toThreadSummary = ({ thread, agents, awaitingApproval }: ThreadOverview): ThreadSummary => {
  const lead = leadOf(agents);
  const ordered = lead ? [lead, ...agents.filter((agent) => agent !== lead)] : agents;
  const status = awaitingApproval
    ? "awaitingApproval"
    : agents.some((agent) => agent.state === "running" || agent.state === "queued")
      ? "running"
      : agents.some((agent) => agent.state === "failed")
        ? "failed"
        : "idle";
  return {
    id: thread.id,
    title: thread.title,
    mode: thread.mode,
    ...(thread.cwd ? { project: baseName(thread.cwd) } : {}),
    status,
    providers: ordered.map((agent) => agent.provider),
    unread: false,
    updatedAt: Math.max(thread.updatedAt, ...agents.map((agent) => agent.updatedAt)),
  };
};

/** Each agent with what its events say about it: usage, latest message, model and pending approvals. */
export const toAgentSummaries = (
  agents: ReadonlyArray<AgentInfo>,
  events: ReadonlyArray<AgentEvent>,
): ReadonlyArray<AgentSummary> =>
  agents.map((agent) => {
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd: number | undefined;
    let lastMessage: string | undefined;
    let model = agent.model;
    const pending = new Set<string>();
    for (const { agentId, payload } of events) {
      if (agentId !== agent.id) continue;
      switch (payload._tag) {
        case "UsageReported":
          inputTokens += payload.inputTokens + (payload.cachedInputTokens ?? 0);
          outputTokens += payload.outputTokens;
          if (payload.costUsd !== undefined) costUsd = (costUsd ?? 0) + payload.costUsd;
          break;
        case "MessageCompleted":
          lastMessage = payload.text;
          break;
        case "SessionStarted":
          model = payload.model;
          break;
        case "PermissionRequested":
          pending.add(payload.requestId);
          break;
        case "PermissionResolved":
          pending.delete(payload.requestId);
          break;
      }
    }
    return {
      id: agent.id,
      ...(agent.parentId ? { parentId: agent.parentId } : {}),
      role: agent.role,
      provider: agent.provider,
      model: modelLabel(model),
      ...(agent.effort ? { effort: agent.effort } : {}),
      access: agent.access,
      state: agent.state,
      awaitingApproval: pending.size > 0 && agent.state !== "stopped",
      usage: { inputTokens, outputTokens, ...(costUsd === undefined ? {} : { costUsd }) },
      ...(lastMessage ? { lastMessage } : {}),
      startedAt: agent.createdAt,
    };
  });
