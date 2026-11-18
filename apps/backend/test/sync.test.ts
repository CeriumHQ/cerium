import {
  MAX_SYNC_BATCH_BYTES,
  type AgentEvent,
  type AgentId,
  type EventId,
  type ThreadId,
  type ThreadOverview,
  type ThreadOverviewUpdate,
  type UiEvent,
  type DeviceMessage,
} from "@cerium/protocol";
import { Account, type RelayEvent } from "@cerium/account";
import { Orchestrator } from "@cerium/orchestrator";
import { Store } from "@cerium/store";
import { assert, describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, PubSub, Stream } from "effect";
import { TestClock } from "effect/testing";

import { batches, cloudEvent, CloudCopy } from "../src/sync.ts";

const event = (sequence: number, text = "done"): AgentEvent => ({
  id: `evt_${sequence}` as EventId,
  threadId: "thr_1" as ThreadId,
  agentId: "agt_1" as AgentId,
  sequence,
  at: sequence,
  payload: { _tag: "MessageCompleted", messageId: `m${sequence}`, text },
  raw: { provider: "secret" },
});

const thread: ThreadOverview["thread"] = {
  id: event(1).threadId,
  title: "Sync",
  mode: "work",
  createdAt: 1,
  updatedAt: 1,
};
const agent: ThreadOverview["agents"][number] = {
  id: event(1).agentId,
  threadId: thread.id,
  role: "lead",
  provider: "claude",
  model: "claude-opus-5-5",
  access: "ask",
  state: "idle",
  createdAt: 1,
  updatedAt: 1,
};
const overview: ThreadOverview = { thread, agents: [agent], awaitingApproval: false };

const startCopy = (
  account: Account["Service"],
  orchestrator: Orchestrator["Service"],
  store: Store["Service"],
) =>
  Layer.build(
    CloudCopy.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Account, account),
          Layer.succeed(Orchestrator, orchestrator),
          Layer.succeed(Store, store),
        ),
      ),
    ),
  );

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

describe("batches", () => {
  it("keep each batch under the size the relay stores, in order", () => {
    const big = (sequence: number) => cloudEvent(event(sequence, "y".repeat(400_000)));
    const split = batches([big(1), big(2), big(3)]);
    expect(split.map((batch) => batch.map((each: UiEvent) => each.sequence))).toEqual([[1, 2], [3]]);
    for (const batch of split) expect(JSON.stringify(batch).length).toBeLessThanOrEqual(MAX_SYNC_BATCH_BYTES);
  });
});

describe("cloud upload cursors", () => {
  const exercise = (reconnect: boolean) =>
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createThread(thread);
        yield* store.createAgent(agent);
        yield* store.appendEvents(Array.from({ length: 6 }, (_, i) => event(i + 1, "x".repeat(400_000))));
        const relay = yield* PubSub.unbounded<RelayEvent>();
        const ready = yield* Deferred.make<void>();
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
          watchThreadOverviews: Stream.make({ _tag: "Reset", revision: 0, threads: [overview] }),
        } as unknown as Orchestrator["Service"];
        const tracking = Store.of({
          ...store,
          syncedEventCursor: (id, count) =>
            Effect.sync(() => translated.push(count)).pipe(
              Effect.andThen(store.syncedEventCursor(id, count)),
            ),
        });
        yield* startCopy(account, orchestrator, tracking);
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

it.effect("syncs committed appends and overview patches without scanning idle history", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const store = yield* Store;
      const other = { ...overview, thread: { ...thread, id: "thr_other" as ThreadId }, agents: [] };
      yield* store.createThread(thread);
      yield* store.createThread(other.thread);
      yield* store.createAgent(agent);
      yield* store.appendEvents([event(1)]);
      const relay = yield* PubSub.unbounded<RelayEvent>();
      const ready = yield* Deferred.make<void>();
      const changes = yield* PubSub.unbounded<ThreadOverviewUpdate>();
      const updates = yield* PubSub.subscribe(changes);
      const sent: DeviceMessage[] = [];
      const account = {
        relayEvents: PubSub.subscribe(relay).pipe(Effect.tap(() => Deferred.succeed(ready, undefined))),
        send: (message: DeviceMessage) =>
          Effect.gen(function* () {
            sent.push(message);
            if (message._tag === "SyncEvents") {
              yield* PubSub.publish(relay, {
                _tag: "SyncAccepted",
                threadId: message.threadId,
                count: message.start + message.events.length,
              });
            }
          }),
      } as unknown as Account["Service"];
      const orchestrator = {
        threadOverviews: Effect.die("Sync should consume overview patches"),
        watchThreadOverviews: Stream.make({
          _tag: "Reset",
          revision: 0,
          threads: [overview, other],
        } satisfies ThreadOverviewUpdate).pipe(Stream.concat(Stream.fromSubscription(updates))),
      } as unknown as Orchestrator["Service"];
      let scans = 0;
      const pages: ThreadId[] = [];
      const tracking = Store.of({
        ...store,
        countSyncedEvents: Effect.sync(() => scans++).pipe(Effect.andThen(store.countSyncedEvents)),
        listSyncedEventsAfter: (id, after, limit) =>
          Effect.sync(() => pages.push(id)).pipe(
            Effect.andThen(store.listSyncedEventsAfter(id, after, limit)),
          ),
      });
      yield* startCopy(account, orchestrator, tracking);
      yield* Deferred.await(ready);
      const gone = "thr_gone" as ThreadId;
      yield* PubSub.publish(relay, {
        _tag: "SyncCursors",
        threads: { [thread.id]: 1, [other.thread.id]: 0, [gone]: 2 },
      });
      yield* TestClock.adjust("2 seconds");
      assert.deepEqual(sent.splice(0), [
        { _tag: "SyncThreads", threads: [overview, other] },
        { _tag: "SyncRemoved", threadIds: [gone] },
      ]);

      yield* store.appendEvents([
        { ...event(2), payload: { _tag: "MessageDelta", messageId: "m2", text: "streaming" } },
      ]);
      yield* Effect.flip(store.appendEvents([event(3), event(1)]));
      yield* TestClock.adjust("20 seconds");
      assert.deepEqual({ sent, scans, pages }, { sent: [], scans: 1, pages: [] });

      yield* store.appendEvents([event(3), event(4)]);
      yield* TestClock.adjust("2 seconds");
      assert.deepEqual(sent.splice(0), [
        {
          _tag: "SyncEvents",
          threadId: thread.id,
          start: 1,
          events: [cloudEvent(event(3)), cloudEvent(event(4))],
        },
      ]);

      const renamed = { ...overview, thread: { ...thread, title: "Renamed" } };
      yield* store.updateThread(thread.id, { title: renamed.thread.title });
      yield* store.deleteThread(other.thread.id);
      yield* PubSub.publish(changes, {
        _tag: "Patch",
        revision: 1,
        threads: [renamed],
        removed: [thread.id, other.thread.id],
      });
      yield* TestClock.adjust("20 seconds");
      assert.deepEqual(sent.splice(0), [
        { _tag: "SyncThreads", threads: [renamed] },
        { _tag: "SyncRemoved", threadIds: [other.thread.id] },
      ]);
      assert.deepEqual({ scans, pages }, { scans: 1, pages: [thread.id] });

      const importedThread = { ...thread, id: "thr_imported" as ThreadId };
      const importedAgent = { ...agent, id: "agt_imported" as AgentId, threadId: importedThread.id };
      const imported = { thread: importedThread, agents: [importedAgent], awaitingApproval: false };
      const importedEvent = {
        ...event(1),
        id: "evt_imported" as EventId,
        threadId: importedThread.id,
        agentId: importedAgent.id,
      };
      yield* store.createThread(importedThread);
      yield* store.createAgent(importedAgent);
      yield* store.appendEvents([importedEvent]);
      yield* TestClock.adjust("2 seconds");
      assert.deepEqual(sent, []);
      yield* PubSub.publish(changes, {
        _tag: "Patch",
        revision: 2,
        threads: [imported],
        removed: [importedThread.id],
      });
      yield* TestClock.adjust("2 seconds");
      assert.deepEqual(sent.splice(0), [
        { _tag: "SyncThreads", threads: [imported] },
        { _tag: "SyncEvents", threadId: importedThread.id, start: 0, events: [cloudEvent(importedEvent)] },
      ]);
      assert.deepEqual({ scans, pages }, { scans: 1, pages: [thread.id, importedThread.id] });

      yield* PubSub.publish(relay, { _tag: "RelayLost" });
      yield* TestClock.adjust("2 seconds");
      yield* store.appendEvents([event(5)]);
      yield* PubSub.publish(relay, {
        _tag: "SyncCursors",
        threads: { [thread.id]: 3, [importedThread.id]: 1 },
      });
      yield* TestClock.adjust("2 seconds");
      assert.deepEqual(sent, [
        { _tag: "SyncThreads", threads: [renamed, imported] },
        { _tag: "SyncEvents", threadId: thread.id, start: 3, events: [cloudEvent(event(5))] },
      ]);
      assert.strictEqual(scans, 2);
    }),
  ).pipe(Effect.provide(Store.layer({ filename: ":memory:" }))),
);
