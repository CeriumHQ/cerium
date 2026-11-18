import type { AgentId } from "@cerium/protocol";

export const FOLLOWUP_VERSION = 51;

export interface Followup {
  readonly agentId: AgentId;
  /** The composer knows the thread's queue and there is no pending message or approval. */
  readonly ready: boolean;
  readonly suggest: (afterSeq: number) => Promise<string | null>;
}
