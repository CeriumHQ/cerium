import { canArchive, canDelete, type ThreadSummary } from "./model.ts";

/**
 * What the sidebar's bulk bar can do to every selected thread at once. Each runs through the same
 * per-thread path as its row's own action, so the rows' rules still apply.
 */
export type BulkAction = "archive" | "later" | "restore" | "pin" | "unpin" | "read" | "delete";

/** A selected thread an action leaves alone, with why. */
export interface BulkSkip {
  readonly id: string;
  readonly title: string;
  readonly reason: string;
}

/** A bulk action split into the threads it takes and the ones it leaves, with why. */
export interface BulkPlan {
  readonly act: ReadonlyArray<ThreadSummary>;
  readonly skipped: ReadonlyArray<BulkSkip>;
}

const busyReason = (thread: ThreadSummary): string =>
  thread.status === "running"
    ? "its agents are still working"
    : thread.status === "awaitingApproval"
      ? "it's waiting on you"
      : "it can't be moved right now";

/**
 * Splits `ids` into the threads `action` takes and the ones it skips. Unknown ids are dropped.
 * Pinning and marking read are local to this window, so they take every thread; anything that acts
 * where the thread lives skips one on another machine, and archiving, putting off and deleting
 * refuse a thread whose agents are working or waiting, as the rows do.
 */
export const planBulk = (
  byId: ReadonlyMap<string, ThreadSummary>,
  ids: ReadonlyArray<string>,
  action: BulkAction,
): BulkPlan => {
  const act: Array<ThreadSummary> = [];
  const skipped: Array<BulkSkip> = [];
  for (const id of ids) {
    const thread = byId.get(id);
    if (thread === undefined) continue;
    if (action === "pin" || action === "unpin" || action === "read") {
      act.push(thread);
      continue;
    }
    if (thread.elsewhere !== undefined) {
      skipped.push({ id, title: thread.title, reason: `it's on ${thread.machine ?? "another machine"}` });
      continue;
    }
    if (action === "restore") {
      act.push(thread);
      continue;
    }
    if ((action === "archive" || action === "later" ? canArchive : canDelete)(thread)) {
      act.push(thread);
    } else {
      skipped.push({ id, title: thread.title, reason: busyReason(thread) });
    }
  }
  return { act, skipped };
};

const pastParticiple: Record<BulkAction, string> = {
  archive: "archived",
  later: "moved to Later",
  restore: "brought back to the inbox",
  pin: "pinned",
  unpin: "unpinned",
  read: "marked as read",
  delete: "deleted",
};

/**
 * One line saying what a bulk action did and which threads it skipped, with why:
 * "Archived 3 · 1 skipped: “X” (its agents are still working)".
 */
export const summarizeBulk = (action: BulkAction, plan: BulkPlan): string => {
  const acted = plan.act.length;
  const head =
    acted > 0
      ? `${pastParticiple[action][0]!.toUpperCase()}${pastParticiple[action].slice(1)} ${acted}`
      : "Nothing changed";
  if (plan.skipped.length === 0) return head;
  const skipped = plan.skipped.map(({ title, reason }) => `“${title}” (${reason})`).join("; ");
  return `${head} · ${plan.skipped.length} skipped: ${skipped}`;
};

/** Toggles one thread in the selection. */
export const toggleSelected = (selected: ReadonlyArray<string>, id: string): ReadonlyArray<string> =>
  selected.includes(id) ? selected.filter((candidate) => candidate !== id) : [...selected, id];

/**
 * Adds to the selection the run from `anchor` (or the thread itself when there is none) to `id`
 * in the list's order, keeping what was already selected. An id the list doesn't show selects
 * nothing more.
 */
export const rangeSelected = (
  ordered: ReadonlyArray<string>,
  selected: ReadonlyArray<string>,
  anchor: string | undefined,
  id: string,
): ReadonlyArray<string> => {
  const end = ordered.indexOf(id);
  if (end === -1) return selected;
  const start = anchor === undefined ? end : ordered.indexOf(anchor);
  const from = start === -1 ? end : Math.min(start, end);
  const to = start === -1 ? end : Math.max(start, end);
  const known = new Set(selected);
  return [...selected, ...ordered.slice(from, to + 1).filter((candidate) => !known.has(candidate))];
};
