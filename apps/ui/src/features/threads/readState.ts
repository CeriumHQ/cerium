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

export const isUnread = (state: ReadState, threadId: string, updatedAt: number): boolean =>
  updatedAt > (state.seen[threadId] ?? state.since);

export function useReadState() {
  const [state, setState] = useState(load);
  const save = (seen: ReadState["seen"]) => {
    const next = { ...state, seen: { ...state.seen, ...seen } };
    remember(SEEN_KEY, Schema.encodeSync(StoredReadState)(next));
    setState(next);
  };
  return {
    isUnread: (threadId: string, updatedAt: number) => isUnread(state, threadId, updatedAt),
    /** Marks threads seen as of their latest activity. */
    markRead: (threads: ReadonlyArray<{ readonly id: string; readonly updatedAt: number }>) =>
      save(Object.fromEntries(threads.map(({ id, updatedAt }) => [id, updatedAt]))),
    markUnread: (threadId: string) => save({ [threadId]: 0 }),
  };
}
