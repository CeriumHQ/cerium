import type { AgentEvent, AgentId, AgentInfo, EventId, ThreadId, ThreadInfo } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import { join } from "node:path";

import { Store } from "../src/index.ts";

const migrationsFolder = join(import.meta.dirname, "..", "migrations");
const withStore = <A, E>(effect: Effect.Effect<A, E, Store>) =>
  effect.pipe(Effect.provide(Store.layer({ filename: ":memory:", migrationsFolder })));

const thread: ThreadInfo = {
  id: "thr_1" as ThreadId,
  title: "Fix flaky test",
  mode: "work",
  cwd: "C:/repo",
  createdAt: 1,
  updatedAt: 1,
};

const lead: AgentInfo = {
  id: "agt_lead" as AgentId,
  threadId: thread.id,
  role: "lead",
  provider: "claude",
  model: "claude-opus-5-5",
  effort: "high",
  access: "ask",
  state: "idle",
  createdAt: 2,
  updatedAt: 2,
};

const event = (sequence: number, text = `message ${sequence}`): AgentEvent => ({
  id: `evt_${sequence}` as EventId,
  threadId: thread.id,
  agentId: lead.id,
  sequence,
  at: 10 + sequence,
  payload: { _tag: "MessageCompleted", messageId: `m${sequence}`, text },
});

describe("Store", () => {
  it.effect("round-trips threads, keeping absent optional fields absent", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const chat: ThreadInfo = {
          id: "thr_chat" as ThreadId,
          title: "Q",
          mode: "chat",
          createdAt: 3,
          updatedAt: 3,
        };
        yield* store.createThread(thread);
        yield* store.createThread(chat);
        assert.deepStrictEqual(yield* store.getThread(thread.id), Option.some(thread));
        assert.deepStrictEqual(yield* store.listThreads, [thread, chat]);
        assert.isTrue(Option.isNone(yield* store.getThread("missing" as ThreadId)));
      }),
    ),
  );

  it.effect("creates, updates and lists agents", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const child: AgentInfo = {
          ...lead,
          id: "agt_child" as AgentId,
          parentId: lead.id,
          role: "reviewer",
          access: "readOnly",
          createdAt: 5,
          updatedAt: 5,
        };
        yield* store.createThread(thread);
        yield* store.createAgent(lead);
        yield* store.createAgent(child);
        yield* store.updateAgent(lead.id, { state: "running", providerSessionId: "s-1", updatedAt: 9 });

        const agents = yield* store.listAgents(thread.id);
        assert.deepStrictEqual(
          agents.map((agent) => [agent.id, agent.state]),
          [
            [lead.id, "running"],
            [child.id, "idle"],
          ],
        );
        assert.deepStrictEqual(yield* store.getAgent(child.id), Option.some(child));
        assert.strictEqual(Option.getOrThrow(yield* store.getAgent(lead.id)).providerSessionId, "s-1");
      }),
    ),
  );

  it.effect("appends events and reads them back in sequence order", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createThread(thread);
        yield* store.createAgent(lead);
        assert.isTrue(Option.isNone(yield* store.lastSequence(lead.id)));

        yield* store.appendEvents([event(2), event(0), event(1)]);
        yield* store.appendEvents([]);

        const all = yield* store.listEvents(lead.id);
        assert.deepStrictEqual(
          all.map((stored) => stored.sequence),
          [0, 1, 2],
        );
        assert.deepStrictEqual(all[0], event(0));
        assert.deepStrictEqual(
          (yield* store.listEvents(lead.id, { afterSequence: 0 })).map((stored) => stored.sequence),
          [1, 2],
        );
        assert.deepStrictEqual(yield* store.lastSequence(lead.id), Option.some(2));
      }),
    ),
  );

  it.effect("lists a thread's events across agents and stops agents left live by a previous run", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const child: AgentInfo = { ...lead, id: "agt_child" as AgentId, parentId: lead.id, role: "scout" };
        yield* store.createThread(thread);
        yield* store.createAgent(lead);
        yield* store.createAgent(child);
        yield* store.appendEvents([
          event(0),
          { ...event(0), id: "evt_child" as EventId, agentId: child.id, at: 11 },
        ]);
        yield* store.appendEvents([event(1)]);

        const history = yield* store.listThreadEvents(thread.id);
        assert.deepStrictEqual(
          history.map((stored) => stored.id),
          ["evt_0", "evt_child", "evt_1"],
        );

        yield* store.updateAgent(child.id, { state: "failed", updatedAt: 20 });
        yield* store.stopLiveAgents(30);
        const states = (yield* store.listAgents(thread.id)).map((agent) => agent.state);
        assert.deepStrictEqual(states, ["stopped", "failed"]);
      }),
    ),
  );

  it.effect("stores a batch atomically", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createThread(thread);
        yield* store.createAgent(lead);
        yield* store.appendEvents([event(0)]);

        const duplicate = yield* Effect.exit(
          store.appendEvents([event(1), { ...event(0), id: "evt_dup" as EventId }]),
        );
        assert.isTrue(Exit.isFailure(duplicate));
        assert.deepStrictEqual(
          (yield* store.listEvents(lead.id)).map((stored) => stored.sequence),
          [0],
        );
      }),
    ),
  );

  it.effect("enforces foreign keys", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const orphan = yield* Effect.exit(store.createAgent(lead));
        assert.isTrue(Exit.isFailure(orphan));
      }),
    ),
  );
});
