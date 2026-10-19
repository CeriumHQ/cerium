import type { ThreadMode } from "@cerium/protocol";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";

import { Backend } from "./client.ts";

/** How long the backend has to answer before the search settles for titles. */
const ANSWER_WITHIN = "10 seconds";

/**
 * The threads of one mode whose messages hold every word of a query; keyed by mode and query on
 * separate lines. The read waits for a pause in typing: each keystroke makes a new atom, and the
 * one it replaces is interrupted before it asks. A machine too old to know the call fails it.
 */
export const threadSearchAtom = Atom.family((key: string) => {
  const [mode, ...query] = key.split("\n") as [ThreadMode, ...Array<string>];
  return Backend.runtime.atom(
    Effect.sleep("180 millis").pipe(
      Effect.andThen(Backend.use((client) => client("SearchThreads", { query: query.join("\n"), mode }))),
      Effect.timeout(ANSWER_WITHIN),
    ),
  );
});

export const threadSearchKey = (mode: ThreadMode, query: string) => `${mode}\n${query}`;
