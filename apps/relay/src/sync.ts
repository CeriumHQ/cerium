import type { ReadEntry } from "@cerium/protocol";

// The cloud copy of each thread: its events in the order the machine
// stored them, appended in batches. A batch can arrive again (its answer was lost) or out of turn
// (an earlier one was), so the relay keeps only what follows on from what it has. A device that
// connects is sent the threads' overviews and the account's drafts as the relay stored them.

export interface Appended<A> {
  /** The events to store, starting at the count the cloud had. */
  readonly keep: ReadonlyArray<A>;
  /** How many of the thread's events the cloud has afterwards. */
  readonly count: number;
}

/**
 * What a batch adds to a thread the cloud has `stored` events of. A batch starting past them leaves
 * a gap, so nothing is kept and the machine resends from `stored`; one starting earlier is trimmed.
 */
export const appendBatch = <A>(stored: number, start: number, events: ReadonlyArray<A>): Appended<A> => {
  if (start > stored) return { keep: [], count: stored };
  const keep = events.slice(stored - start);
  return { keep, count: stored + keep.length };
};

/**
 * The `AccountThreads` message a device gets on connecting, as `JSON.stringify` would write it. The
 * overviews are stored as JSON already, each written by the relay from one it decoded, so they're
 * joined in as they are rather than parsed only to be written out again.
 */
export const accountThreadsJson = (
  threads: ReadonlyArray<{ readonly machine: string; readonly overview: string }>,
  read: ReadonlyArray<ReadEntry>,
): string => {
  const list = threads.map(
    ({ machine, overview }) => `{"machine":${JSON.stringify(machine)},"overview":${overview}}`,
  );
  return `{"_tag":"AccountThreads","threads":[${list.join(",")}],"read":${JSON.stringify(read)}}`;
};

/** The `AccountDrafts` message a device gets on connecting, each stored draft's JSON joined in likewise. */
export const accountDraftsJson = (
  drafts: ReadonlyArray<{ readonly key: string; readonly updatedAt: number; readonly draft: string | null }>,
): string => {
  const list = drafts.map(
    ({ key, updatedAt, draft }) =>
      `{"key":${JSON.stringify(key)},"updatedAt":${JSON.stringify(updatedAt)}${draft === null ? "" : `,"draft":${draft}`}}`,
  );
  return `{"_tag":"AccountDrafts","drafts":[${list.join(",")}]}`;
};
