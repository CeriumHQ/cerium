import { isStreamDelta, type AgentEvent, type ThreadId } from "@cerium/protocol";
import { Effect, PubSub, Queue, Stream } from "effect";

/** Confirms the reader is registered before yielding its queued events. */
const deliveries = (events: Stream.Stream<AgentEvent>) =>
  Stream.concat(
    Stream.succeed({ _tag: "Subscribed" } as const),
    events.pipe(Stream.map((event) => ({ _tag: "Event" as const, event }))),
  );

export const makeEventFeeds = Effect.gen(function* () {
  const legacy = yield* PubSub.unbounded<AgentEvent>();
  const activity = yield* PubSub.unbounded<AgentEvent>();
  const threads = new Map<ThreadId, Set<Queue.Queue<AgentEvent>>>();

  return {
    events: Stream.fromPubSub(legacy),
    activity: Stream.fromPubSub(activity),
    watchActivity: Stream.unwrap(
      PubSub.subscribe(activity).pipe(
        Effect.map((subscription) => deliveries(Stream.fromSubscription(subscription))),
      ),
    ),
    watchThread: (threadId: ThreadId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<AgentEvent>();
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const readers = threads.get(threadId) ?? new Set<Queue.Queue<AgentEvent>>();
              threads.set(threadId, readers);
              readers.add(queue);
              return readers;
            }),
            (readers) =>
              Effect.sync(() => {
                readers.delete(queue);
                if (readers.size === 0) threads.delete(threadId);
              }),
          );
          return deliveries(Stream.fromQueue(queue));
        }),
      ),
    publish: (event: AgentEvent) =>
      Effect.sync(() => {
        PubSub.publishUnsafe(legacy, event);
        if (!isStreamDelta(event.payload._tag)) PubSub.publishUnsafe(activity, event);
        const readers = threads.get(event.threadId);
        if (readers !== undefined) {
          for (const reader of readers) Queue.offerUnsafe(reader, event);
        }
      }),
  };
});
