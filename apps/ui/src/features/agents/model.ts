import type { AccessMode, AgentState, ProviderId, ReasoningEffort } from "@cerium/protocol";

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
};
