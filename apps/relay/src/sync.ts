// The cloud copy of each thread: its events in the order the machine
// stored them, appended in batches. A batch can arrive again (its answer was lost) or out of turn
// (an earlier one was), so the relay keeps only what follows on from what it has.

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
