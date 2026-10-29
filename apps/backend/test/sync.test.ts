import {
  MAX_SYNC_BATCH_BYTES,
  type AgentEvent,
  type AgentId,
  type EventId,
  type ThreadId,
  type ThreadOverview,
  type UiEvent,
  type DeviceMessage,
} from "@cerium/protocol";
import { Account, type RelayEvent } from "@cerium/account";
import { Orchestrator } from "@cerium/orchestrator";
import { Store } from "@cerium/store";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, PubSub, Stream } from "effect";
import { TestClock } from "effect/testing";

import { batches, cloudEvent, CloudCopy, lastActive } from "../src/sync.ts";

const event = (sequence: number, text = "done"): AgentEvent => ({
  id: `evt_${sequence}` as EventId,
  threadId: "thr_1" as ThreadId,
  agentId: "agt_1" as AgentId,
  sequence,
  at: sequence,
  payload: { _tag: "MessageCompleted", messageId: `m${sequence}`, text },
  raw: { provider: "secret" },
});

describe("an event's cloud copy", () => {
  it("is the event as the UI sees it, without the provider's raw message", () => {
    const copy = cloudEvent(event(1));
    expect("raw" in copy).toBe(false);
    expect(copy.payload).toEqual({ _tag: "MessageCompleted", messageId: "m1", text: "done" });
  });

  it("cuts very long strings when the event is too big to store", () => {
    const copy = cloudEvent(event(2, "x".repeat(MAX_SYNC_BATCH_BYTES + 10)));
    const text = (copy.payload as { text: string }).text;
    expect(text.length).toBeLessThan(60_000);
    expect(text.endsWith("(shortened in the cloud copy)")).toBe(true);
  });
});

describe("lastActive", () => {
  it("is when the thread or the last of its agents changed", () => {
    const overview = (thread: number, agents: ReadonlyArray<number>) =>
      ({
        thread: { updatedAt: thread },
        agents: agents.map((updatedAt) => ({ updatedAt })),
        awaitingApproval: false,
      }) as unknown as ThreadOverview;
    expect(lastActive(overview(5, []))).toBe(5);
    expect(lastActive(overview(5, [3, 9, 7]))).toBe(9);
  });
});

describe("batches", () => {
  it("keep each batch under the size the relay stores, in order", () => {
    const big = (sequence: number) => cloudEvent(event(sequence, "y".repeat(400_000)));
    const split = batches([big(1), big(2), big(3)]);
    expect(split.map((batch) => batch.map((each: UiEvent) => each.sequence))).toEqual([[1, 2], [3]]);
    for (const batch of split) expect(JSON.stringify(batch).length).toBeLessThanOrEqual(MAX_SYNC_BATCH_BYTES);
  });

  it("make none of nothing", () => {
    expect(batches([])).toEqual([]);
  });
});

describe("cloud upload cursors", () => {
  const exercise = (reconnect: boolean) =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* Store;
        const thread: ThreadOverview["thread"] = {
          id: "thr_1" as ThreadId,
          title: "Sync",
          mode: "work",
          createdAt: 1,
          updatedAt: 1,
        };
        const agent: ThreadOverview["agents"][number] = {
          id: "agt_1" as AgentId,
          threadId: thread.id,
          role: "lead",
          provider: "claude",
          model: "claude-opus-5-5",
          access: "ask",
          state: "idle",
          createdAt: 1,
          updatedAt: 1,
        };
        yield* store.createThread(thread);
        yield* store.createAgent(agent);
        yield* store.appendEvents(Array.from({ length: 6 }, (_, i) => event(i + 1, "x".repeat(400_000))));
        const relay = yield* PubSub.unbounded<RelayEvent>();
        const ready = yield* Deferred.make<void>();
        const activity = yield* PubSub.unbounded<AgentEvent>();
        const sent: Array<Extract<DeviceMessage, { _tag: "SyncEvents" }>> = [];
        const translated: number[] = [];
        let interrupted = false;
        const account = {
          relayEvents: PubSub.subscribe(relay).pipe(Effect.tap(() => Deferred.succeed(ready, undefined))),
          send: (message: DeviceMessage) =>
            Effect.gen(function* () {
              if (message._tag !== "SyncEvents") return;
              sent.push(message);
              if (!interrupted && sent.length === (reconnect ? 2 : 1)) {
                interrupted = true;
                if (reconnect) {
                  // The relay stored this byte batch, but its acknowledgement was lost with the socket.
                  yield* PubSub.publish(relay, { _tag: "RelayLost" });
                  yield* PubSub.publish(relay, {
                    _tag: "SyncCursors",
                    threads: { [thread.id]: message.start + message.events.length },
                  });
                } else yield* PubSub.publish(relay, { _tag: "SyncAccepted", threadId: thread.id, count: 1 });
              } else
                yield* PubSub.publish(relay, {
                  _tag: "SyncAccepted",
                  threadId: thread.id,
                  count: message.start + message.events.length,
                });
            }),
        } as unknown as Account["Service"];
        const orchestrator = {
          threadOverviews: Effect.succeed([{ thread, agents: [agent], awaitingApproval: false }]),
          events: Stream.fromPubSub(activity),
        } as unknown as Orchestrator["Service"];
        const tracking = Store.of({
          ...store,
          syncedEventCursor: (id, count) =>
            Effect.sync(() => translated.push(count)).pipe(
              Effect.andThen(store.syncedEventCursor(id, count)),
            ),
        });
        yield* Layer.build(
          CloudCopy.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(Account, account),
                Layer.succeed(Orchestrator, orchestrator),
                Layer.succeed(Store, tracking),
              ),
            ),
          ),
        );
        yield* Deferred.await(ready);
        yield* PubSub.publish(relay, { _tag: "SyncCursors", threads: { [thread.id]: reconnect ? 0 : 2 } });
        yield* TestClock.adjust("1 second");
        yield* TestClock.adjust(reconnect ? "1 second" : "15 seconds");
        yield* TestClock.adjust("1 second");
        if (reconnect) {
          expect(sent.map((message) => message.start)).toEqual([0, 2, 4]);
          expect(sent.map((message) => message.events.map((item) => item.id))).toEqual([
            ["evt_1", "evt_2"],
            ["evt_3", "evt_4"],
            ["evt_5", "evt_6"],
          ]);
          expect(translated).toEqual([0, 4]);
        } else {
          expect(sent.map((message) => message.start)).toEqual([2, 1, 3, 5]);
          expect(sent[1]!.events[0]!.id).toBe("evt_2");
          expect(translated).toEqual([2, 1]);
        }
      }),
    ).pipe(Effect.provide(Store.layer({ filename: ":memory:" })));

  it.effect("resumes a partial byte page from the relay's count after reconnect", () => exercise(true));
  it.effect("resolves a relay gap once and retries from the returned count", () => exercise(false));
});
