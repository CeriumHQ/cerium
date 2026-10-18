import { Account } from "@cerium/account";
import { Orchestrator } from "@cerium/orchestrator";
import type {
  AgentEvent,
  AgentId,
  AgentInfo,
  DeviceMessage,
  EventId,
  EventPayload,
  ThreadId,
  ThreadInfo,
} from "@cerium/protocol";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";

import { decide, Notifier, notificationLine, type TurnEnd } from "../src/notify.ts";

const thread: ThreadInfo = {
  id: "thr_1" as ThreadId,
  title: "Fix the login redirect",
  mode: "work",
  createdAt: 1,
  updatedAt: 1,
};

const agent = (id: string, state: AgentInfo["state"], parentId?: string): AgentInfo => ({
  id: id as AgentId,
  threadId: thread.id,
  ...(parentId === undefined ? {} : { parentId: parentId as AgentId }),
  role: parentId === undefined ? "lead" : "reviewer",
  provider: "claude",
  model: "opus",
  access: "ask",
  state,
  createdAt: 1,
  updatedAt: 1,
});

const ended =
  (ends: Record<string, TurnEnd>) =>
  (agentId: AgentId): TurnEnd =>
    ends[agentId] ?? {};

describe("what a settled thread is told as", () => {
  it("waits on the user while a request it made is still open", () => {
    const agents = [agent("lead", "running")];
    expect(decide({ asked: "Run npm test" }, agents, true, ended({}))).toEqual({
      kind: "needsYou",
      detail: "Run npm test",
    });
    // Answered before it settled: nobody needs telling.
    expect(decide({ asked: "Run npm test" }, agents, false, ended({}))).toBeUndefined();
  });

  it("finished once nothing works and the lead's turn ended on its own", () => {
    const agents = [agent("lead", "idle"), agent("child", "idle", "lead")];
    const ends = ended({ lead: { stopReason: "completed", message: "Fixed it." } });
    expect(decide({ wentIdle: true }, agents, false, ends)).toEqual({
      kind: "finished",
      detail: "Fixed it.",
    });
    // A child done while the lead works on its answer isn't the thread finishing.
    const working = [agent("lead", "queued"), agent("child", "idle", "lead")];
    expect(decide({ wentIdle: true }, working, false, ends)).toBeUndefined();
  });

  it("says nothing about a turn the user stopped", () => {
    const ends = ended({ lead: { stopReason: "interrupted" } });
    expect(decide({ wentIdle: true }, [agent("lead", "idle")], false, ends)).toBeUndefined();
  });

  it("failed when an agent failed, or the lead's turn ended in an error, with nothing else working", () => {
    const ends = ended({ child: { error: "Rate limited" }, lead: { stopReason: "error", error: "Crashed" } });
    const failed = [agent("lead", "idle"), agent("child", "failed", "lead")];
    expect(decide({ failed: "child" as AgentId }, failed, false, ends)).toEqual({
      kind: "failed",
      detail: "Rate limited",
    });
    expect(
      decide({ failed: "child" as AgentId }, [agent("lead", "running"), failed[1]!], false, ends),
    ).toBeUndefined();
    expect(decide({ wentIdle: true }, [agent("lead", "idle")], false, ends)).toEqual({
      kind: "failed",
      detail: "Crashed",
    });
  });
});

describe("a notification's line", () => {
  it("is the message as plain text on one line", () => {
    expect(
      notificationLine("## Done\n\n**Fixed** the `redirect` in [auth.ts](src/auth.ts).\n- tests pass"),
    ).toBe("Done Fixed the redirect in auth.ts. tests pass");
    expect(notificationLine("Here:\n```ts\nconst x = 1;\n```\nThat's all.")).toBe("Here: That's all.");
    expect(notificationLine("  \n ")).toBeUndefined();
  });

  it("is cut to fit", () => {
    const line = notificationLine("word ".repeat(100))!;
    expect(line.length).toBeLessThanOrEqual(240);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("the notifier", () => {
  /** A machine with one thread whose agents and events the test sets, and what it sends the relay. */
  const machine = Effect.gen(function* () {
    const events = yield* Queue.unbounded<AgentEvent>();
    const sent: Array<DeviceMessage> = [];
    const state = { agents: [agent("lead", "idle")], awaiting: false };
    let sequence = 0;
    const orchestrator = Layer.succeed(Orchestrator, {
      events: Stream.fromQueue(events),
      listAgents: () => Effect.succeed(state.agents),
      awaitingApproval: () => state.awaiting,
      listThreads: Effect.succeed([thread]),
    } as never);
    const account = Layer.succeed(Account, {
      send: (message: DeviceMessage) => Effect.sync(() => void sent.push(message)),
    } as never);
    yield* Layer.build(Notifier.pipe(Layer.provide(Layer.merge(orchestrator, account))));
    const emit = (agentId: string, payload: EventPayload) =>
      Queue.offer(events, {
        id: `evt_${sequence}` as EventId,
        threadId: thread.id,
        agentId: agentId as AgentId,
        sequence: sequence++,
        at: sequence,
        payload,
      });
    /** Lets the notifier take what was emitted, then lets `seconds` pass. */
    const wait = (seconds: number) =>
      Effect.gen(function* () {
        for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
        yield* TestClock.adjust(`${seconds} seconds`);
        for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
      });
    return { sent, state, emit, wait };
  });

  it.effect("tells the relay a thread finished once it settled, with the lead's last message", () =>
    Effect.gen(function* () {
      const { sent, emit, wait } = yield* machine;
      yield* emit("lead", { _tag: "TurnInput", items: [{ _tag: "FromUser", text: "Fix it" }] });
      yield* emit("lead", { _tag: "MessageCompleted", messageId: "m1", text: "**Fixed** the redirect." });
      yield* emit("lead", { _tag: "TurnCompleted", stopReason: "completed" });
      yield* emit("lead", { _tag: "AgentStateChanged", state: "idle" });
      yield* wait(2);
      assert.deepStrictEqual(sent, []);
      yield* wait(3);
      assert.deepStrictEqual(sent, [
        {
          _tag: "Notify",
          threadId: thread.id,
          title: "Fix the login redirect",
          kind: "finished",
          detail: "Fixed the redirect.",
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("tells nothing when the thread is working again by the time it settles", () =>
    Effect.gen(function* () {
      const { sent, state, emit, wait } = yield* machine;
      state.agents = [agent("lead", "idle"), agent("child", "running", "lead")];
      yield* emit("child", { _tag: "TurnCompleted", stopReason: "completed" });
      yield* emit("child", { _tag: "AgentStateChanged", state: "idle" });
      yield* wait(2);
      // The lead takes the child's answer.
      state.agents = [agent("lead", "queued"), agent("child", "idle", "lead")];
      yield* wait(3);
      assert.deepStrictEqual(sent, []);
    }).pipe(Effect.scoped),
  );

  it.effect("tells a request once, as the latest one, while it's still open", () =>
    Effect.gen(function* () {
      const { sent, state, emit, wait } = yield* machine;
      state.agents = [agent("lead", "running")];
      state.awaiting = true;
      yield* emit("lead", {
        _tag: "PermissionRequested",
        requestId: "r1",
        toolName: "Bash",
        summary: "Run `npm install`",
        input: {},
      });
      yield* wait(2);
      yield* emit("lead", {
        _tag: "PermissionRequested",
        requestId: "r2",
        toolName: "Bash",
        summary: "Run `npm test`",
        input: {},
      });
      yield* wait(5);
      assert.deepStrictEqual(sent, [
        {
          _tag: "Notify",
          threadId: thread.id,
          title: "Fix the login redirect",
          kind: "needsYou",
          detail: "Run npm test",
        },
      ]);
    }).pipe(Effect.scoped),
  );
});
