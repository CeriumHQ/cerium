import type { AgentEvent, KeptFile, RestoredFile } from "@cerium/protocol";

import type { SnapshotChange } from "./services.ts";

// Restoring a work thread's files to before one of the user's messages. A folder may be shared with
// other threads, so a restore puts back only what this thread's agents changed since then, and leaves
// a file another thread changed too: undoing this thread must never undo theirs.

/** What one agent did to the folder from a point on: its turns' snapshots, and the files it named. */
export interface Work {
  /** Each turn's snapshot before it and, once it ended, after it. */
  readonly spans: ReadonlyArray<{ readonly from: string; readonly to?: string }>;
  /** The files its harness said it changed, as the harness named them. */
  readonly files: ReadonlyArray<string>;
}

/** What an agent's events say it did to the folder in the turns it began at or after `since`. */
export const workSince = (events: ReadonlyArray<AgentEvent>, since: number): Work => {
  const spans: Array<{ from: string; to?: string }> = [];
  const files: Array<string> = [];
  /** The turns still waiting for their snapshot after, by `turnId`; the last one also without. */
  const open = new Map<string | undefined, { from: string; to?: string }>();
  for (const { payload, at } of events) {
    switch (payload._tag) {
      case "TurnInput":
        open.delete(undefined);
        if (at >= since && payload.files !== undefined) {
          const span = { from: payload.files };
          spans.push(span);
          open.set(payload.turnId, span);
          open.set(undefined, span);
        }
        break;
      case "FilesSaved": {
        const span = open.get(payload.turnId);
        if (span !== undefined) span.to = payload.snapshot;
        open.delete(payload.turnId);
        break;
      }
      // A turn begun before `since` that was still running counts from then on through what it named.
      case "FileChanged":
        if (at >= since) files.push(payload.path);
        break;
      default:
        break;
    }
  }
  return { spans, files };
};

/** How a restore undoes a file's change since the snapshot it goes back to. */
const undoOf = (change: SnapshotChange["change"]): RestoredFile["undo"] =>
  change === "added" ? "create" : change === "deleted" ? "delete" : "edit";

/**
 * Splits the files that differ between the snapshot a restore goes back to and now into those it puts
 * back (this thread changed them and no other did) and those it keeps (another thread changed them
 * too, by the title of the first). Files only other threads, or the user, changed aren't listed.
 */
export const planRestore = (
  differing: ReadonlyArray<SnapshotChange>,
  ours: ReadonlySet<string>,
  theirs: ReadonlyMap<string, string>,
): { readonly restored: ReadonlyArray<RestoredFile>; readonly kept: ReadonlyArray<KeptFile> } => {
  const restored: Array<RestoredFile> = [];
  const kept: Array<KeptFile> = [];
  for (const { path, change } of differing.toSorted((a, b) => a.path.localeCompare(b.path))) {
    if (!ours.has(path)) continue;
    const other = theirs.get(path);
    if (other === undefined) restored.push({ path, undo: undoOf(change) });
    else kept.push({ path, thread: other });
  }
  return { restored, kept };
};
