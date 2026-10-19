import type { AccessMode, AgentState, ProviderId, ReasoningEffort } from "@cerium/protocol";

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

/** What the inspector shows for one agent, derived from its record and event log. */
export interface AgentSummary {
  readonly id: string;
  /** Absent for the thread's lead. */
  readonly parentId?: string;
  readonly role: string;
  readonly provider: ProviderId;
  readonly model: string;
  readonly effort?: ReasoningEffort;
  readonly access: AccessMode;
  readonly state: AgentState;
  /** A permission request, or a spawn request of the lead's, is waiting on the user. */
  readonly awaitingApproval: boolean;
  /** The requests waiting on the user, oldest first. */
  readonly approvals: ReadonlyArray<PendingApproval>;
  /** The lead's requests to start an agent that wait on the user, oldest first. */
  readonly spawns: ReadonlyArray<SpawnRequest>;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly costUsd?: number };
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
    };

/**
 * Everything the thread's agents wait on the user for, in the order it was asked: the children's
 * permission requests, and the lead's requests to start an agent. The lead's own permission
 * requests are answered in the conversation, beside the work they interrupt.
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
      ...agent.spawns.map((request) => ({
        kind: "spawn" as const,
        key: `spawn:${request.requestId}`,
        agent,
        request,
      })),
    ])
    .toSorted((a, b) => a.request.at - b.request.at);
