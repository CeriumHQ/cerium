import { Option, Schema } from "effect";
import { useState } from "react";

import { remember, stored } from "../../lib/storage.ts";

// Which work threads the user has seen since they last changed. It only marks the inbox, so it lives
// with the window's preferences rather than the backend.

const SEEN_KEY = "cerium:seen";

const ReadState = Schema.Struct({
  /** Threads with no entry count as seen up to here: when tracking started, so history isn't unread. */
  since: Schema.Finite,
  /** When each thread was last seen, by its last activity then; 0 marks it unread by hand. */
  seen: Schema.Record(Schema.String, Schema.Finite),
});
type ReadState = typeof ReadState.Type;
const StoredReadState = Schema.fromJsonString(ReadState);

const load = (): ReadState =>
  Schema.decodeUnknownOption(StoredReadState)(stored(SEEN_KEY)).pipe(
    Option.getOrElse(() => {
      const fresh = { since: Date.now(), seen: {} };
      remember(SEEN_KEY, Schema.encodeSync(StoredReadState)(fresh));
      return fresh;
    }),
  );

/**
 * Whether a thread changed since it was last seen, here or on another device of the account
 * (`elsewhere`). Marking it unread here counts over what other devices saw.
 */
export const isUnread = (
  state: ReadState,
  threadId: string,
  updatedAt: number,
  elsewhere?: ReadonlyMap<string, number>,
): boolean => {
  const here = state.seen[threadId];
  if (here === 0) return true;
  return updatedAt > Math.max(here ?? state.since, elsewhere?.get(threadId) ?? 0);
};

/**
 * The window's read state. `elsewhere` is what the account's other devices have seen; `share`
 * tells them what this one saw.
 */
export function useReadState(
  elsewhere?: ReadonlyMap<string, number>,
  share?: (entries: ReadonlyArray<{ readonly threadId: string; readonly seenAt: number }>) => void,
) {
  const [state, setState] = useState(load);
  const save = (seen: ReadState["seen"]) => {
    const next = { ...state, seen: { ...state.seen, ...seen } };
    remember(SEEN_KEY, Schema.encodeSync(StoredReadState)(next));
    setState(next);
  };
  return {
    isUnread: (threadId: string, updatedAt: number) => isUnread(state, threadId, updatedAt, elsewhere),
    /** Marks threads seen as of their latest activity, on every device of the account. */
    markRead: (threads: ReadonlyArray<{ readonly id: string; readonly updatedAt: number }>) => {
      save(Object.fromEntries(threads.map(({ id, updatedAt }) => [id, updatedAt])));
      share?.(threads.map(({ id, updatedAt }) => ({ threadId: id, seenAt: updatedAt })));
    },
    markUnread: (threadId: string) => save({ [threadId]: 0 }),
  };
}
