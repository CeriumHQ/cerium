import type {
  AccessMode,
  AgentState,
  ProviderId,
  Question,
  ReasoningEffort,
  TodoItem,
} from "@cerium/protocol";

/** A permission request an agent is waiting on the user to answer. */
export interface PendingApproval {
  readonly requestId: string;
  readonly toolName: string;
  readonly summary: string;
  readonly input: unknown;
  /** When the agent asked. */
  readonly at: number;
}

/**
 * A lead's request to start an agent outside the catalog, waiting on the user. What the agent would
 * run with and be told is absent from requests older versions recorded.
 */
export interface SpawnRequest {
  readonly requestId: string;
  readonly role: string;
  readonly provider: ProviderId;
  readonly model: string;
  readonly effort?: ReasoningEffort;
  readonly access?: AccessMode;
  readonly prompt?: string;
  readonly at: number;
}

/** Questions an agent put to the user with `ask_user` that nobody has answered yet. */
export interface PendingQuestion {
  readonly requestId: string;
  readonly questions: ReadonlyArray<Question>;
  readonly at: number;
}

export interface AgentContext {
  readonly tokens: number;
  readonly window?: number;
}

/** What fraction of its window the context fills, when the window is known; at most 1. */
export const contextFill = (context: AgentContext | undefined): number | undefined =>
  context?.window === undefined ? undefined : Math.min(1, context.tokens / context.window);

/** From this fill on, the meter warns that the harness will soon compact. */
export const CONTEXT_NEARLY_FULL = 0.8;

/** What the inspector shows for one agent, derived from its record and event log. */
export interface AgentSummary {
  readonly id: string;
  /** Absent for the thread's lead. */
  readonly parentId?: string;
  readonly role: string;
  readonly provider: ProviderId;
  readonly model: string;
  readonly effort?: ReasoningEffort;
  /** The effort router picks its effort each turn, while the router is on. */
  readonly autoEffort?: true;
  readonly access: AccessMode;
  readonly state: AgentState;
  /** A permission request, a question, or a spawn request of the lead's, is waiting on the user. */
  readonly awaitingApproval: boolean;
  /** The requests waiting on the user, oldest first. */
  readonly approvals: ReadonlyArray<PendingApproval>;
  /** The lead's requests to start an agent that wait on the user, oldest first. */
  readonly spawns: ReadonlyArray<SpawnRequest>;
  /** The questions waiting on the user's answer, oldest first. */
  readonly questions: ReadonlyArray<PendingQuestion>;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly costUsd?: number };
  /**
   * The tokens in the agent's context as its harness last measured them, against its model's window
   * where the harness reports one. Absent until a harness reports it, and after the conversation went
   * back or moved to another harness.
   */
  readonly context?: AgentContext;
  /** The agent's todo list or plan as its harness last reported it, whole; empty when it keeps none. */
  readonly todos: ReadonlyArray<TodoItem>;
  /** Why the agent last changed its plan, when its harness said. */
  readonly todosNote?: string;
  /** The agent's latest completed message. */
  readonly lastMessage?: string;
  /** What its harness last reported going wrong; what a failed agent stopped on. */
  readonly error?: string;
  readonly startedAt: number;
}

export type AgentDisplayState = "needsYou" | "running" | "queued" | "idle" | "stopped" | "failed";

export const displayState = (agent: AgentSummary): AgentDisplayState =>
  agent.awaitingApproval ? "needsYou" : agent.state;

export const displayStateLabel: Record<AgentDisplayState, string> = {
  needsYou: "Needs you",
  running: "Working",
  queued: "Queued",
  idle: "Idle",
  stopped: "Stopped",
  failed: "Failed",
};

/** A child that went idle has delivered its result: that reads as done. */
export const stateLabel = (agent: AgentSummary): string =>
  agent.parentId !== undefined && displayState(agent) === "idle"
    ? "Done"
    : displayStateLabel[displayState(agent)];

export const accessLabel: Record<AccessMode, string> = {
  readOnly: "Read only",
  ask: "Ask first",
  acceptEdits: "Accept edits",
  auto: "Auto",
  fullAccess: "Full access",
};

/** Which entries an agent's context menu offers; none at all means it has no menu. */
export interface AgentMenuPlan {
  /** Selects the agent in the agents panel: only offered from a spawn card. */
  readonly show: boolean;
  readonly message: boolean;
  /** `disabled` between turns: there is nothing to interrupt. */
  readonly interrupt: "enabled" | "disabled" | "hidden";
  readonly stop: boolean;
}

/**
 * An ended agent has nothing left to do, so only its spawn card keeps an entry (a way to see it in
 * the panel). Children can't be messaged from the UI, only the lead.
 */
export const agentMenuPlan = (
  agent: Pick<AgentSummary, "parentId" | "state">,
  options: { readonly card: boolean; readonly canMessage: boolean },
): AgentMenuPlan => {
  const ended = agent.state === "stopped" || agent.state === "failed";
  const busy = agent.state === "running" || agent.state === "queued";
  return {
    show: options.card,
    message: !ended && agent.parentId === undefined && options.canMessage,
    interrupt: ended ? "hidden" : busy ? "enabled" : "disabled",
    stop: !ended,
  };
};

export const hasAgentMenu = (plan: AgentMenuPlan): boolean =>
  plan.show || plan.message || plan.interrupt !== "hidden" || plan.stop;

/** How many agents are in each state that deserves a word at a glance; states with none are left out. */
export const statusCounts = (
  agents: ReadonlyArray<AgentSummary>,
): ReadonlyArray<{ readonly state: "needsYou" | "running" | "failed"; readonly count: number }> => {
  const count = { needsYou: 0, running: 0, failed: 0 };
  for (const agent of agents) {
    const state = displayState(agent);
    if (state === "needsYou") count.needsYou++;
    else if (state === "running" || state === "queued") count.running++;
    else if (state === "failed") count.failed++;
  }
  return (["needsYou", "running", "failed"] as const).flatMap((state) =>
    count[state] > 0 ? [{ state, count: count[state] }] : [],
  );
};

/** One provider's share of a thread's usage; `costUsd` is absent when none of its agents reported one. */
export interface ProviderUsage {
  readonly provider: ProviderId;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd?: number;
}

/**
 * The thread's usage per provider, in the order each first appears, leaving out providers that
 * haven't counted anything yet. Only some harnesses report a cost, so `total` is what was reported
 * and `partial` says some tokens have no cost in it.
 */
export const threadUsage = (
  agents: ReadonlyArray<AgentSummary>,
): {
  readonly providers: ReadonlyArray<ProviderUsage>;
  readonly total: number;
  readonly partial: boolean;
} => {
  const byProvider = new Map<ProviderId, { -readonly [K in keyof ProviderUsage]: ProviderUsage[K] }>();
  for (const { provider, usage } of agents) {
    const sum = byProvider.get(provider) ?? { provider, inputTokens: 0, outputTokens: 0 };
    sum.inputTokens += usage.inputTokens;
    sum.outputTokens += usage.outputTokens;
    if (usage.costUsd !== undefined) sum.costUsd = (sum.costUsd ?? 0) + usage.costUsd;
    byProvider.set(provider, sum);
  }
  const providers = [...byProvider.values()].filter(
    ({ inputTokens, outputTokens }) => inputTokens + outputTokens > 0,
  );
  return {
    providers,
    total: providers.reduce((sum, { costUsd }) => sum + (costUsd ?? 0), 0),
    partial: providers.some(({ costUsd }) => costUsd === undefined),
  };
};

/** A request waiting on the user, from the agent that is asking. */
export type QueuedRequest =
  | {
      readonly kind: "permission";
      readonly key: string;
      readonly agent: AgentSummary;
      readonly request: PendingApproval;
    }
  | {
      readonly kind: "spawn";
      readonly key: string;
      readonly agent: AgentSummary;
      readonly request: SpawnRequest;
    }
  | {
      readonly kind: "question";
      readonly key: string;
      readonly agent: AgentSummary;
      readonly request: PendingQuestion;
    };

/**
 * Everything the thread's agents wait on the user for, in the order it was asked: the children's
 * permission requests and questions, and the lead's requests to start an agent. The lead's own
 * permission requests and questions are answered in the conversation, beside the work they interrupt.
 */
export const requestQueue = (agents: ReadonlyArray<AgentSummary>): ReadonlyArray<QueuedRequest> =>
  agents
    .flatMap((agent): ReadonlyArray<QueuedRequest> => [
      ...(agent.parentId === undefined
        ? []
        : agent.approvals.map((request) => ({
            kind: "permission" as const,
            key: `permission:${request.requestId}`,
            agent,
            request,
          }))),
      ...(agent.parentId === undefined
        ? []
        : agent.questions.map((request) => ({
            kind: "question" as const,
            key: `question:${request.requestId}`,
            agent,
            request,
          }))),
      ...agent.spawns.map((request) => ({
        kind: "spawn" as const,
        key: `spawn:${request.requestId}`,
        agent,
        request,
      })),
    ])
    .toSorted((a, b) => a.request.at - b.request.at);

/** The `RPC_VERSION` that brought `StopThread`; an older machine's threads are stopped agent by agent. */
export const STOP_THREAD_VERSION = 10;

/** The shortcut the window listens for to stop everything in the open thread. */
export const STOP_ALL_SHORTCUT = "Ctrl Shift .";

/** What "Stop everything" would end in a thread: the agents at work and the requests it would deny. */
export const stopAllScope = (
  agents: ReadonlyArray<AgentSummary>,
): { readonly agents: number; readonly approvals: number } => ({
  agents: agents.filter(({ state }) => state === "running" || state === "queued").length,
  approvals: agents.reduce((sum, { approvals, spawns }) => sum + approvals.length + spawns.length, 0),
});

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The confirmation's sentence: only the parts that apply. */
export const stopAllSummary = (scope: { readonly agents: number; readonly approvals: number }): string => {
  const parts = [
    ...(scope.agents > 0 ? [plural(scope.agents, "working agent", "working agents")] : []),
    ...(scope.approvals > 0 ? [plural(scope.approvals, "pending approval", "pending approvals")] : []),
  ];
  return parts.join(" and ");
};
