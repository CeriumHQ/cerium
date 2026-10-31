import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { AccessMode, AccountThreads, LiveUiEvent, ThreadOverviews, UiEvents } from "../src/index.ts";

// What a newer version wrote, read by this one.

const event = (sequence: number, payload: object) => ({
  id: `evt_${sequence}`,
  threadId: "thr_1",
  agentId: "agt_1",
  sequence,
  at: 1_760_000_000_000 + sequence,
  payload,
});

const overview = (id: string, agent: object) => ({
  thread: { id, title: "Fix the build", mode: "work", createdAt: 1, updatedAt: 2 },
  agents: [
    {
      id: `agt_${id}`,
      threadId: id,
      role: "lead",
      provider: "claude",
      model: "opus",
      access: "ask",
      state: "running",
      createdAt: 1,
      updatedAt: 2,
      ...agent,
    },
  ],
  awaitingApproval: false,
});

describe("reading a newer version's data", () => {
  it.effect("reads an access mode it doesn't know as ask", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* Schema.decodeUnknownEffect(AccessMode)("reviewed"), "ask");
      assert.strictEqual(yield* Schema.decodeUnknownEffect(AccessMode)("auto"), "auto");
    }),
  );

  it.effect("keeps a thread whose agent is in an unknown mode or state", () =>
    Effect.gen(function* () {
      const [thread] = yield* Schema.decodeUnknownEffect(ThreadOverviews)([
        overview("thr_1", { access: "reviewed", state: "paused" }),
      ]);
      assert.strictEqual(thread?.agents[0]?.access, "ask");
      assert.strictEqual(thread?.agents[0]?.state, "idle");
    }),
  );

  it.effect("skips only the threads it can't read", () =>
    Effect.gen(function* () {
      const threads = yield* Schema.decodeUnknownEffect(ThreadOverviews)([
        overview("thr_1", {}),
        overview("thr_2", { provider: "someNewHarness" }),
        overview("thr_3", {}),
      ]);
      assert.deepStrictEqual(
        threads.map((each) => each.thread.id),
        ["thr_1", "thr_3"],
      );
      const account = yield* Schema.decodeUnknownEffect(AccountThreads)({
        threads: [
          { machine: "m1", overview: overview("thr_1", {}) },
          { machine: "m1", overview: overview("thr_2", { provider: "someNewHarness" }) },
        ],
        read: [],
      });
      assert.strictEqual(account.threads.length, 1);
    }),
  );

  it.effect("skips events of kinds it doesn't know, and keeps the rest", () =>
    Effect.gen(function* () {
      const events = yield* Schema.decodeUnknownEffect(UiEvents)([
        event(0, { _tag: "MessageCompleted", messageId: "m1", text: "Hello" }),
        event(1, { _tag: "SomethingNew", detail: 1 }),
        event(2, { _tag: "TurnCompleted", stopReason: "handedOff" }),
      ]);
      assert.deepStrictEqual(
        events.map((each) => each.payload),
        [
          { _tag: "MessageCompleted", messageId: "m1", text: "Hello" },
          { _tag: "TurnCompleted", stopReason: "completed" },
        ],
      );
    }),
  );

  it.effect("reads a live event of an unknown kind as undefined", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(LiveUiEvent);
      assert.isUndefined(yield* decode(event(0, { _tag: "SomethingNew" })));
      const known = yield* decode(event(1, { _tag: "MessageDelta", messageId: "m1", text: "Hi" }));
      assert.strictEqual(known?.payload._tag, "MessageDelta");
    }),
  );
});
