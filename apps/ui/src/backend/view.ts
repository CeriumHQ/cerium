import type {
  AgentEvent,
  AgentInfo,
  BackgroundTask,
  ModelInfo,
  ProviderId,
  TodoItem,
} from "@cerium/protocol";
import type { ThreadOverview } from "@cerium/rpc";

import type {
  AgentContext,
  AgentSummary,
  PendingApproval,
  PendingQuestion,
  SpawnRequest,
} from "../features/agents/model.ts";
import type { ThreadSummary } from "../features/threads/model.ts";

// Maps backend records onto the view models the components render.

// Harnesses report the model a session resolved to, which can differ from the alias it was started
// with and from what the harness lists.
const resolvedLabels: Record<string, string> = {
  "claude-opus-5-5": "Opus 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-haiku-5-5": "Haiku 5.5",
  "claude-fable-5-1": "Fable 5.1",
};

/** A model as people know it: the harness's own label when it lists the model. */
export const modelLabel = (models: ReadonlyArray<ModelInfo>, provider: ProviderId, model: string) =>
  models.find((candidate) => candidate.provider === provider && candidate.id === model)?.label ??
  resolvedLabels[model] ??
  model;

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
  // A thread in a worktree belongs with its project's other threads.
  const folder = thread.worktree?.project ?? thread.cwd;
  return {
    id: thread.id,
    title: thread.title,
    mode: thread.mode,
    ...(folder ? { project: baseName(folder), folder } : {}),
    ...(thread.worktree
      ? {
          worktree: {
            ...(thread.worktree.id ? { id: thread.worktree.id } : {}),
            branch: thread.worktree.branch,
            base: thread.worktree.base,
          },
        }
      : {}),
    status,
    providers: ordered.map((agent) => agent.provider),
    unread: false,
    createdAt: thread.createdAt,
    updatedAt: Math.max(thread.updatedAt, ...agents.map((agent) => agent.updatedAt)),
    ...(thread.archivedAt ? { archivedAt: thread.archivedAt } : {}),
    ...(thread.laterUntil ? { laterUntil: thread.laterUntil } : {}),
    ...(lead ? { lead: { id: lead.id, model: lead.model } } : {}),
    ...(thread.runId ? { runId: thread.runId } : {}),
  };
};

/** Each agent with what its events say about it: usage, todo list, latest message, model and pending approvals. */
export const toAgentSummaries = (
  agents: ReadonlyArray<AgentInfo>,
  events: ReadonlyArray<AgentEvent>,
  models: ReadonlyArray<ModelInfo>,
): ReadonlyArray<AgentSummary> =>
  agents.map((agent) => {
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd: number | undefined;
    let todos: ReadonlyArray<TodoItem> = [];
    let todosNote: string | undefined;
    let background: ReadonlyArray<BackgroundTask> = [];
    let lastMessage: string | undefined;
    let error: string | undefined;
    let model = agent.model;
    let context: AgentContext | undefined;
    const pending = new Map<string, PendingApproval>();
    const spawning = new Map<string, SpawnRequest>();
    const asking = new Map<string, PendingQuestion>();
    for (const { agentId, payload, at } of events) {
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
        case "TodosUpdated":
          todos = payload.items;
          todosNote = payload.explanation;
          break;
        case "BackgroundTasksChanged":
          background = payload.tasks;
          break;
        case "ContextReported": {
          const window = payload.window ?? context?.window;
          context = window === undefined ? { tokens: payload.tokens } : { tokens: payload.tokens, window };
          break;
        }
        case "ContextCompacted":
          // Without a size after, the old reading no longer holds until the harness measures again.
          context =
            payload.tokensAfter === undefined ? undefined : { ...context, tokens: payload.tokensAfter };
          break;
        case "ConversationRewound":
          context = undefined;
          break;
        case "SessionStarted":
        case "ModelChanged":
        case "LeadHandedOff":
          model = payload.model;
          // Another model's window is its own; another harness starts the conversation over.
          if (payload._tag === "LeadHandedOff") context = undefined;
          else if (payload._tag === "ModelChanged" && context) context = { tokens: context.tokens };
          break;
        case "AgentError":
          error = payload.message;
          break;
        case "PermissionRequested":
          pending.set(payload.requestId, {
            requestId: payload.requestId,
            toolName: payload.toolName,
            summary: payload.summary,
            input: payload.input,
            at,
          });
          break;
        case "PermissionResolved":
          pending.delete(payload.requestId);
          break;
        case "SpawnApprovalRequested":
          spawning.set(payload.requestId, {
            requestId: payload.requestId,
            role: payload.role,
            provider: payload.provider,
            model: modelLabel(models, payload.provider, payload.model),
            ...(payload.effort ? { effort: payload.effort } : {}),
            ...(payload.access ? { access: payload.access } : {}),
            ...(payload.prompt ? { prompt: payload.prompt } : {}),
            at,
          });
          break;
        case "SpawnApprovalResolved":
          spawning.delete(payload.requestId);
          break;
        case "QuestionAsked":
          asking.set(payload.requestId, { requestId: payload.requestId, questions: payload.questions, at });
          break;
        case "QuestionResolved":
          asking.delete(payload.requestId);
          break;
      }
    }
    // An agent that stopped or failed can't act on an answer: its requests ended with its session.
    const ended = agent.state === "stopped" || agent.state === "failed";
    const approvals = ended ? [] : [...pending.values()];
    const spawns = ended ? [] : [...spawning.values()];
    const questions = ended ? [] : [...asking.values()];
    return {
      id: agent.id,
      ...(agent.parentId ? { parentId: agent.parentId } : {}),
      role: agent.role,
      provider: agent.provider,
      model: modelLabel(models, agent.provider, model),
      ...(agent.effort ? { effort: agent.effort } : {}),
      ...(agent.autoEffort ? { autoEffort: true as const } : {}),
      ...(agent.speed ? { speed: agent.speed } : {}),
      access: agent.access,
      state: agent.state,
      awaitingApproval: approvals.length > 0 || spawns.length > 0 || questions.length > 0,
      approvals,
      spawns,
      questions,
      usage: { inputTokens, outputTokens, ...(costUsd === undefined ? {} : { costUsd }) },
      ...(context ? { context } : {}),
      todos,
      ...(todosNote ? { todosNote } : {}),
      // Its background tasks ended with its session.
      background: ended ? [] : background,
      ...(lastMessage ? { lastMessage } : {}),
      ...(error ? { error } : {}),
      startedAt: agent.createdAt,
    };
  });
