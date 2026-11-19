import type { AgentEvent, AgentId, EventId, EventPayload, ThreadId } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";

import { makeEventFeeds } from "../src/eventFeeds.ts";

const a = "thr_a" as ThreadId;
const b = "thr_b" as ThreadId;
const event = (threadId: ThreadId, sequence: number, payload: EventPayload): AgentEvent => ({
  id: `${threadId}:${sequence}` as EventId,
  threadId,
  agentId: `agt_${threadId}` as AgentId,
  sequence,
  at: sequence,
  payload,
});
const delivered = (event: AgentEvent) => ({ _tag: "Event" as const, event });

describe("live event feeds", () => {
  it.effect("routes both kinds of text only to their thread and legacy readers", () =>
    Effect.gen(function* () {
      const feeds = yield* makeEventFeeds;
      const activity = yield* Stream.toPull(feeds.watchActivity);
      const light = yield* Stream.toPull(feeds.watchActivityWithoutTools);
      const first = yield* Stream.toPull(feeds.watchThread(a));
      const second = yield* Stream.toPull(feeds.watchThread(b));
      const legacy = yield* feeds.events.pipe(
        Stream.take(5),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      for (const pull of [activity, light, first, second]) {
        assert.deepStrictEqual(yield* pull, [{ _tag: "Subscribed" }]);
      }

      const message = event(a, 0, { _tag: "MessageDelta", messageId: "m", text: "Hello", offset: 0 });
      const reasoning = event(b, 0, { _tag: "ReasoningDelta", messageId: "r", text: "Hmm", offset: 0 });
      const completed = event(a, 1, { _tag: "MessageCompleted", messageId: "m", text: "Hello" });
      const tool = event(a, 2, {
        _tag: "ToolCallCompleted",
        callId: "read",
        output: "file text",
        isError: false,
      });
      const ended = event(b, 1, { _tag: "TurnCompleted", stopReason: "interrupted" });
      yield* Effect.forEach([message, reasoning, completed, tool, ended], feeds.publish, { discard: true });

      assert.deepStrictEqual(yield* first, [delivered(message), delivered(completed), delivered(tool)]);
      assert.deepStrictEqual(yield* second, [delivered(reasoning), delivered(ended)]);
      assert.deepStrictEqual(yield* activity, [delivered(completed), delivered(tool), delivered(ended)]);
      assert.deepStrictEqual(yield* light, [delivered(completed), delivered(ended)]);
      assert.deepStrictEqual(yield* Fiber.join(legacy), [message, reasoning, completed, tool, ended]);
    }).pipe(Effect.scoped),
  );

  it.effect("queues events from the ready marker and starts fresh on reconnect", () =>
    Effect.gen(function* () {
      const feeds = yield* makeEventFeeds;
      const stream = feeds.watchThread(a);
      const whileClosed = event(a, 1, { _tag: "MessageDelta", messageId: "m", text: "lo", offset: 3 });
      const whileReading = event(a, 2, { _tag: "MessageDelta", messageId: "m", text: "!", offset: 5 });
      const firstConnection = yield* stream.pipe(Stream.take(1), Stream.runCollect);
      assert.deepStrictEqual(firstConnection, [{ _tag: "Subscribed" }]);
      yield* feeds.publish(whileClosed);

      const reconnected = yield* Stream.toPull(stream);
      assert.deepStrictEqual(yield* reconnected, [{ _tag: "Subscribed" }]);
      yield* feeds.publish(whileReading);
      assert.deepStrictEqual(yield* reconnected, [delivered(whileReading)]);
    }).pipe(Effect.scoped),
  );
});
