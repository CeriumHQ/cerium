import type { ThreadId } from "@cerium/protocol";
import type { ReviewRecord } from "@cerium/rpc";
import { Effect, Schedule, Stream } from "effect";
import { Atom } from "effect/reactivity";

import { Backend } from "./client.ts";
import { machineAtom } from "./machine.ts";

// Reviews of a diff by an agent on another harness, as a thread holds them: each reviewer at work,
// then its findings on the diff's lines, each sent to the thread's agent or dismissed.

/** The `RPC_VERSION` that brought reviews; an older machine offers none. */
export const REVIEWS_VERSION = 38;

/**
 * A thread's reviews, oldest first, now and after every change; subscribed again after a lost
 * connection. An empty id, for no thread, reads as none.
 */
export const reviewsAtom = Atom.family((threadId: ThreadId) =>
  Backend.runtime
    .atom((get) => {
      get(machineAtom);
      if (threadId === "") return Stream.succeed<ReadonlyArray<ReviewRecord>>([]);
      return Stream.unwrap(
        Backend.use((client) => Effect.succeed(client("WatchReviews", { threadId }))),
      ).pipe(Stream.retry(Schedule.spaced("2 seconds")));
    })
    .pipe(Atom.setIdleTTL("1 minute")),
);

export const startReview = Backend.mutation("StartReview");
export const resolveReviewFinding = Backend.mutation("ResolveReviewFinding");
export const stopReview = Backend.mutation("StopReview");
