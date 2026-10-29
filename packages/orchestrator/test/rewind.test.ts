import { makeFakeAdapter } from "@cerium/harness/testing";
import type { AgentEvent, AgentId, EventPayload } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Exit } from "effect";

import { Orchestrator } from "../src/index.ts";
import { REWIND_TAGS, liveEvents, replayNotice, rewindPoint } from "../src/rewind.ts";
import { recordEvents, testLayer } from "./fakes.ts";

/** A conversation of one agent, numbered as the store would. */
const log = (...payloads: ReadonlyArray<EventPayload>): ReadonlyArray<AgentEvent> =>
  payloads.map(
    (payload, sequence) =>
      ({
        id: `a:${sequence}`,
        threadId: "t",
        agentId: "a",
        sequence,
        at: sequence,
        payload,
      }) as AgentEvent,
  );

const turn = (id: string, text: string): EventPayload => ({
  _tag: "TurnInput",
  items: [{ _tag: "FromUser", id, text }],
  turnId: `turn-${id}`,
});
const reply = (text: string): ReadonlyArray<EventPayload> => [
  { _tag: "MessageCompleted", messageId: text, text },
  { _tag: "TurnCompleted", stopReason: "completed" },
];

describe("rewind points", () => {
  it("counts the turns of the session the agent runs, and drops what earlier rewinds replaced", () => {
    const events = log(
      turn("m1", "one"),
      ...reply("first"),
      turn("m2", "two"),
      ...reply("second"),
      // Back to before "two" by a fork: the session still holds "one".
      { _tag: "ConversationRewound", fromSequence: 3, messageId: "m2", via: "fork" },
      turn("m3", "two again"),
      ...reply("second again"),
    );
    assert.deepStrictEqual(
      liveEvents(events).map(({ payload }) => payload._tag),
      [
        "TurnInput",
        "MessageCompleted",
        "TurnCompleted",
        "ConversationRewound",
        "TurnInput",
        "MessageCompleted",
        "TurnCompleted",
      ],
    );
    const point = rewindPoint(events, "m3");
    assert.deepInclude(point, { fromSequence: 7, via: "fork", turn: { index: 1, id: "turn-m3" } });
    assert.deepInclude(rewindPoint(events, "m1"), { fromSequence: 0, via: "fresh" });
    assert.deepStrictEqual(rewindPoint(events, "m2"), {
      problem: "That message is no longer in the conversation.",
    });
    const actionHistory = events.filter(({ payload }) => REWIND_TAGS.includes(payload._tag));
    for (const id of ["m1", "m2", "m3"]) {
      assert.deepStrictEqual(rewindPoint(actionHistory, id), rewindPoint(events, id));
    }
  });

  it("counts from a session that started anew, and replays to go back before its first turn", () => {
    const events = log(
      turn("m1", "one"),
      ...reply("first"),
      turn("m2", "two"),
      ...reply("second"),
      { _tag: "ConversationRewound", fromSequence: 3, messageId: "m2", via: "replay" },
      turn("m3", "two again"),
      ...reply("second again"),
      turn("m4", "three"),
    );
    assert.deepInclude(rewindPoint(events, "m4"), { via: "fork", turn: { index: 1, id: "turn-m4" } });
    assert.deepInclude(rewindPoint(events, "m3"), { via: "replay", turn: { index: 0, id: "turn-m3" } });
  });

  it("tells a replaying session each turn and the agent's answer, once", () => {
    const events = log(turn("m1", "one"), ...reply("first"), turn("m2", "two"), ...reply("second"), {
      _tag: "ConversationRewound",
      fromSequence: 3,
      messageId: "m2",
      via: "replay",
    });
    const notice = replayNotice(liveEvents(events)) ?? "";
    assert.include(notice, "[Input]\none");
    assert.include(notice, "[You]\nfirst");
    assert.notInclude(notice, "second");
    // Once the new session has taken a turn, there's nothing left to tell.
    assert.isUndefined(
      replayNotice(liveEvents([...events, ...log(turn("m3", "x")).map((e) => ({ ...e, sequence: 9 }))])),
    );
  });
});

const messageIds = (events: ReadonlyArray<AgentEvent>, agentId: AgentId) =>
  events.flatMap((event) =>
    event.agentId === agentId && event.payload._tag === "MessageQueued"
      ? [event.payload.message.id ?? ""]
      : [],
  );

/** Starts a thread and has its lead answer `texts` one turn at a time. */
const converse = (texts: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    const recorded = yield* recordEvents;
    const { lead } = yield* orchestrator.createThread({
      title: "Rewind",
      mode: "work",
      cwd: ".",
      lead: { provider: "claude", model: "opus", access: "ask" },
    });
    for (const [index, text] of texts.entries()) {
      yield* orchestrator.sendUserMessage(lead.id, text);
      yield* recorded.waitFor((events) => {
        const ended = events.filter(
          (event) => event.agentId === lead.id && event.payload._tag === "TurnCompleted",
        );
        return ended.length > index ? true : undefined;
      });
    }
    yield* recorded.waitFor((events) => {
      const state = events.findLast(
        (event) => event.agentId === lead.id && event.payload._tag === "AgentStateChanged",
      )?.payload;
      return state?._tag === "AgentStateChanged" && state.state === "idle" ? true : undefined;
    });
    return { orchestrator, lead, ...recorded, ids: messageIds(recorded.seen, lead.id) };
  });

const rewound = (events: ReadonlyArray<AgentEvent>) =>
  events.flatMap((event) => (event.payload._tag === "ConversationRewound" ? [event.payload] : []));

describe("Orchestrator edit and resend", () => {
  it.live("forks the harness session before the edited message and goes on from the new one", () => {
    const fake = makeFakeAdapter("claude", { fork: true });
    return Effect.gen(function* () {
      const { orchestrator, lead, ids, waitFor } = yield* converse(["one", "two", "three"]);
      const turnIds = fake.sessions[0]?.extras.map((extras) => extras?.turnId);

      yield* orchestrator.editMessage(lead.id, ids[1] ?? "", "two, better");
      yield* waitFor((events) =>
        events.find(
          (event) => event.payload._tag === "MessageCompleted" && event.payload.text.includes("better"),
        ),
      );

      assert.deepStrictEqual(fake.forks, [
        { cwd: ".", sessionId: "fake-1", before: { index: 1, id: turnIds?.[1] ?? "" } },
      ]);
      assert.strictEqual(fake.sessions[1]?.options.resume, "fork-1");
      assert.deepStrictEqual(fake.sessions[1]?.sent, ["two, better"]);
      const events = yield* orchestrator.threadEvents(lead.threadId);
      const [marker] = rewound(events);
      assert.strictEqual(marker?.via, "fork");
      assert.strictEqual(marker?.messageId, ids[1]);
      const replacedTurn = events.find((event) => event.sequence === marker?.fromSequence);
      assert.strictEqual(replacedTurn?.payload._tag, "TurnInput");
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("tells a new session the conversation so far where the harness can't fork", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const { orchestrator, lead, ids, waitFor } = yield* converse(["one", "two"]);

      yield* orchestrator.editMessage(lead.id, ids[1] ?? "", "two, better");
      yield* waitFor((events) =>
        events.filter((event) => event.payload._tag === "TurnCompleted").length === 3 ? true : undefined,
      );

      assert.isUndefined(fake.sessions[1]?.options.resume, "a new session");
      const sent = fake.sessions[1]?.sent[0] ?? "";
      assert.include(sent, "[Input]\none");
      assert.include(sent, "[You]\nreply to: one");
      assert.notInclude(sent, "reply to: two");
      assert.isTrue(sent.endsWith("two, better"), "the edited message follows the conversation");
      assert.strictEqual(rewound(yield* orchestrator.threadEvents(lead.threadId))[0]?.via, "replay");
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("starts anew for the first message, and replays when a fork fails", () => {
    const fake = makeFakeAdapter("claude", { fork: "fail" });
    return Effect.gen(function* () {
      const { orchestrator, lead, ids, waitFor } = yield* converse(["one", "two"]);

      yield* orchestrator.editMessage(lead.id, ids[1] ?? "", "two, better");
      yield* waitFor((events) => (rewound(events).length === 1 ? true : undefined));
      assert.strictEqual(rewound(yield* orchestrator.threadEvents(lead.threadId))[0]?.via, "replay");
      assert.strictEqual(fake.forks.length, 1);

      yield* orchestrator.editMessage(lead.id, ids[0] ?? "", "one, better");
      yield* waitFor((events) =>
        events.find(
          (event) =>
            event.payload._tag === "MessageCompleted" && event.payload.text === "reply to: one, better",
        ),
      );
      assert.strictEqual(rewound(yield* orchestrator.threadEvents(lead.threadId))[1]?.via, "fresh");
      assert.isUndefined(fake.sessions.at(-1)?.options.resume);
      assert.deepStrictEqual(fake.sessions.at(-1)?.sent, ["one, better"]);
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("stops a running turn to go back, and refuses messages no longer in the conversation", () => {
    const fake = makeFakeAdapter("claude", { fork: true, turnDuration: Duration.millis(300) });
    return Effect.gen(function* () {
      const { orchestrator, lead, ids, waitFor, seen } = yield* converse(["one"]);
      yield* orchestrator.sendUserMessage(lead.id, "two");
      yield* waitFor((events) =>
        events.filter((event) => event.agentId === lead.id && event.payload._tag === "TurnInput").length === 2
          ? true
          : undefined,
      );
      const two = messageIds(seen, lead.id)[1] ?? "";

      const original = yield* orchestrator.rewindLead(lead.id, two);
      assert.strictEqual(original.text, "two");
      assert.strictEqual((yield* orchestrator.listAgents(lead.threadId))[0]?.state, "idle");
      assert.deepStrictEqual(
        fake.forks.map((fork) => fork.before.index),
        [1],
      );
      yield* waitFor(() => fake.sessions[1]);
      assert.strictEqual(fake.sessions[1]?.options.resume, "fork-1");
      assert.deepStrictEqual(fake.sessions[1]?.sent, [], "the stopped turn isn't sent again");

      const again = yield* orchestrator.rewindLead(lead.id, two).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(again));
      assert.strictEqual(ids.length, 1);
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });
});
