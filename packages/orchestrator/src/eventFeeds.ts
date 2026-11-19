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
  const activityWithoutTools = yield* PubSub.unbounded<AgentEvent>();
  const threads = new Map<ThreadId, Set<Queue.Queue<AgentEvent>>>();

  const watch = (source: PubSub.PubSub<AgentEvent>) =>
    Stream.unwrap(
      PubSub.subscribe(source).pipe(
        Effect.map((subscription) => deliveries(Stream.fromSubscription(subscription))),
      ),
    );

  return {
    events: Stream.fromPubSub(legacy),
    activity: Stream.fromPubSub(activity),
    watchActivity: watch(activity),
    watchActivityWithoutTools: watch(activityWithoutTools),
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
        const tag = event.payload._tag;
        if (!isStreamDelta(tag)) {
          PubSub.publishUnsafe(activity, event);
          if (tag !== "ToolCallStarted" && tag !== "ToolCallCompleted")
            PubSub.publishUnsafe(activityWithoutTools, event);
        }
        const readers = threads.get(event.threadId);
        if (readers !== undefined) {
          for (const reader of readers) Queue.offerUnsafe(reader, event);
        }
      }),
  };
});
