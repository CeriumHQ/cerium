import type { AgentEvent } from "@cerium/protocol";

/** What one thread of a multi-agent run did, to set beside the others. */
export interface RunStats {
  /** Lines added and removed by its turns, less the turns the user undid. */
  readonly added: number;
  readonly removed: number;
  /** Files changed, each counted once. */
  readonly files: number;
  /** How long its lead took over the first message, from the thread's start; absent until it finished. */
  readonly took?: number;
}

/** A thread's run, from its events: its files' changes and how long its lead took to answer. */
export const runStats = (events: ReadonlyArray<AgentEvent>, leadId: string, startedAt: number): RunStats => {
  const turns = new Map<string, Extract<AgentEvent["payload"], { _tag: "TurnFilesChanged" }>>();
  const undone = new Set<string>();
  let finished: number | undefined;
  for (const { agentId, at, payload } of events) {
    if (payload._tag === "TurnFilesChanged") turns.set(payload.turnId, payload);
    else if (payload._tag === "TurnFilesReverted") {
      if (payload.direction === "undone") undone.add(payload.turnId);
      else undone.delete(payload.turnId);
    } else if (payload._tag === "TurnCompleted" && agentId === leadId && finished === undefined) {
      finished = at;
    }
  }
  let added = 0;
  let removed = 0;
  let more = 0;
  const paths = new Set<string>();
  for (const [turnId, turn] of turns) {
    if (undone.has(turnId)) continue;
    more += turn.more ?? 0;
    for (const file of turn.files) {
      paths.add(file.path);
      added += file.added ?? 0;
      removed += file.removed ?? 0;
    }
  }
  return {
    added,
    removed,
    files: paths.size + more,
    ...(finished === undefined ? {} : { took: Math.max(0, finished - startedAt) }),
  };
};

/** A span as a scoreboard shows it: "40s", "9m", "1h 5m". */
export const tookLabel = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
