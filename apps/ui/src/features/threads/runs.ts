import { applyTurnFileRevert, type AgentEvent, type TurnFileState } from "@cerium/protocol";

import { planBulk, type BulkPlan, type BulkSkip } from "./bulk.ts";
import type { ThreadSummary } from "./model.ts";

/** The siblings a comparison can archive, with reasons for any that must stay. */
export const planKeepRun = (threads: ReadonlyArray<ThreadSummary>, winnerId: string): BulkPlan => {
  if (
    !threads.some(
      (thread) => thread.id === winnerId && thread.elsewhere === undefined && thread.archivedAt === undefined,
    )
  ) {
    return { act: [], skipped: [] };
  }
  const siblings = threads.filter((thread) => thread.id !== winnerId && thread.archivedAt === undefined);
  return planBulk(
    new Map(siblings.map((thread) => [thread.id, thread])),
    siblings.map((thread) => thread.id),
    "archive",
  );
};

/** Archives eligible siblings one at a time, keeping the results of partial successes. */
export async function archiveRunSiblings(
  plan: BulkPlan,
  archive: (id: string) => Promise<string | undefined>,
): Promise<BulkPlan> {
  const act: Array<ThreadSummary> = [];
  const skipped: Array<BulkSkip> = [...plan.skipped];
  for (const thread of plan.act) {
    let reason: string | undefined;
    try {
      reason = await archive(thread.id);
    } catch {
      reason = "the archive failed";
    }
    if (reason === undefined) act.push(thread);
    else skipped.push({ id: thread.id, title: thread.title, reason });
  }
  return { act, skipped };
}

/** What one thread of a multi-agent run did, to set beside the others. */
export interface RunStats {
  /** Lines added and removed by its turns, less the turns the user undid. */
  readonly added: number;
  readonly removed: number;
  /** Files changed, each counted once. */
  readonly files: number;
  /** How long its lead took over the first message, from the thread's start; absent until it finished. */
  readonly took?: number;
  /** Reported USD and tokens across agents, absent if the harnesses reported none. */
  readonly costUsd?: number;
  readonly tokens?: number;
}

/** A thread's run, from its events: its files' changes and how long its lead took to answer. */
export const runStats = (
  events: ReadonlyArray<AgentEvent>,
  leadId: string | undefined,
  startedAt: number,
): RunStats => {
  const turns = new Map<string, Extract<AgentEvent["payload"], { _tag: "TurnFilesChanged" }>>();
  const fileStates = new Map<string, ReadonlyMap<string, TurnFileState>>();
  let finished: number | undefined;
  let costUsd: number | undefined;
  let tokens: number | undefined;
  for (const { agentId, at, payload } of events) {
    if (payload._tag === "TurnFilesChanged") {
      turns.set(payload.turnId, payload);
      fileStates.delete(payload.turnId);
    } else if (payload._tag === "TurnFilesReverted") {
      fileStates.set(payload.turnId, applyTurnFileRevert(fileStates.get(payload.turnId), payload));
    } else if (payload._tag === "TurnCompleted" && agentId === leadId && finished === undefined) {
      finished = at;
    } else if (payload._tag === "UsageReported") {
      if (!payload.unreported) {
        tokens =
          (tokens ?? 0) + payload.inputTokens + (payload.cachedInputTokens ?? 0) + payload.outputTokens;
      }
      if (payload.costUsd !== undefined) costUsd = (costUsd ?? 0) + payload.costUsd;
    }
  }
  let added = 0;
  let removed = 0;
  let more = 0;
  const paths = new Set<string>();
  for (const [turnId, turn] of turns) {
    const states = fileStates.get(turnId);
    if (turn.files.every((file) => states?.get(file.path)?.turnUndone)) continue;
    more += turn.more ?? 0;
    for (const file of turn.files) {
      if (states?.get(file.path)?.turnUndone) continue;
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
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(tokens === undefined ? {} : { tokens }),
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
