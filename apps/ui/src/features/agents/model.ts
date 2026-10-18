import type { AccessMode, AgentState, ProviderId, ReasoningEffort } from "@cerium/protocol";

/** A permission request an agent is waiting on the user to answer. */
export interface PendingApproval {
  readonly requestId: string;
  readonly toolName: string;
  readonly summary: string;
  readonly input: unknown;
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
  /** A permission request is waiting on the user. */
  readonly awaitingApproval: boolean;
  /** The requests waiting on the user, oldest first. */
  readonly approvals: ReadonlyArray<PendingApproval>;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly costUsd?: number };
  /** The agent's latest completed message. */
  readonly lastMessage?: string;
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
