import type { ProviderId } from "@cerium/protocol";

/** What the sidebar shows for a thread, derived from the thread and its agents. */
export interface ThreadSummary {
  readonly id: string;
  readonly title: string;
  readonly mode: "work" | "chat";
  /** The folder's name for work threads. */
  readonly project?: string;
  readonly status: "running" | "awaitingApproval" | "idle" | "failed";
  /** Providers of the agents in the thread, lead first. */
  readonly providers: ReadonlyArray<ProviderId>;
  readonly unread: boolean;
  readonly updatedAt: number;
}

export const providerName: Record<ProviderId, string> = {
  claude: "Claude",
  codex: "Codex",
  muse: "Muse",
  cursor: "Cursor",
};
