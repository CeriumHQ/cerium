import { Schema } from "effect";
import { NonNegativeInt, ThreadId } from "./ids.ts";
import { ThreadOverviews, type ThreadOverview } from "./sync.ts";

/** Each subscription starts with a complete snapshot, including archived threads. */
export const ThreadOverviewUpdate = Schema.Union([
  Schema.TaggedStruct("Reset", { revision: NonNegativeInt, threads: ThreadOverviews }),
  Schema.TaggedStruct("Patch", {
    revision: NonNegativeInt,
    threads: ThreadOverviews,
    // Replace these IDs before applying readable upserts. A future provider's skipped upsert must
    // remove its formerly readable row too, rather than leaving stale ownership or approval state.
    removed: Schema.Array(ThreadId),
  }),
]);
export type ThreadOverviewUpdate = typeof ThreadOverviewUpdate.Type;

/** Replacements preserve row identities for every thread the patch leaves alone. */
export const applyOverviewUpdate = (
  current: ReadonlyArray<ThreadOverview>,
  update: ThreadOverviewUpdate,
): ReadonlyArray<ThreadOverview> => {
  if (update._tag === "Reset") return update.threads;
  const next = new Map(current.map((overview) => [overview.thread.id, overview]));
  for (const id of update.removed) next.delete(id);
  for (const overview of update.threads) next.set(overview.thread.id, overview);
  return [...next.values()].toSorted((a, b) => a.thread.createdAt - b.thread.createdAt);
};
