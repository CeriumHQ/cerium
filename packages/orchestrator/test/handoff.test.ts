import { makeFakeAdapter } from "@cerium/harness/testing";
import type { AgentEvent, AgentId, EventPayload } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { handoffBrief, pendingHandoff, splitConversation, exchanges } from "../src/handoff.ts";
import { Orchestrator } from "../src/index.ts";
import { HANDOFF_PREFACE, liveEvents, replayNotice, rewindPoint, startsAnew } from "../src/rewind.ts";
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
const handedOff: EventPayload = {
  _tag: "LeadHandedOff",
  from: { provider: "claude", model: "opus" },
  provider: "codex",
  model: "gpt-6-luna",
};

describe("handoff briefs", () => {
  it("restores conversation context after moving the same harness to another checkout", () => {
    const events = log(turn("m1", "Keep the existing API"), {
      _tag: "WorkspaceMoved",
      from: { provider: "claude", model: "opus" },
      provider: "claude",
      model: "opus",
      previousCwd: "/project",
      cwd: "/worktree",
    });
    assert.isTrue(startsAnew(events));
    assert.isDefined(pendingHandoff(events));
    assert.include(
      handoffBrief(events, { from: { provider: "claude", model: "opus" }, running: [] }),
      "Keep the existing API",
    );
  });
  it("tells the conversation, the files the thread changed, its plan and its running agents", () => {
    const events = log(
      turn("m1", "Fix the parser"),
      { _tag: "TodosUpdated", items: [{ text: "Read the parser", status: "completed" }] },
      {
        _tag: "TurnFilesChanged",
        turnId: "turn-m1",
        before: "s0",
        after: "s1",
        files: [{ path: "src/parse.ts", change: "modified", via: "edit" }],
      },
      ...reply("Fixed the off-by-one in src/parse.ts."),
      handedOff,
    );
    const brief = handoffBrief(events, {
      from: { provider: "claude", model: "opus" },
      running: [{ id: "agt_x" as AgentId, role: "tests", model: "haiku" }],
    });
    assert.isTrue(brief.startsWith(HANDOFF_PREFACE));
    assert.include(brief, "from Claude Code (opus)");
    assert.include(brief, "## The conversation");
    assert.include(brief, "[Input]\nFix the parser");
    assert.include(brief, "[You]\nFixed the off-by-one in src/parse.ts.");
    assert.include(brief, "- src/parse.ts (modified)");
    assert.include(brief, "- [x] Read the parser");
    assert.include(brief, 'agt_x "tests" (haiku)');
  });

  it("keeps the newest turns word for word and condenses the older ones, or lists their requests", () => {
    // Each long message is quoted up to 6,000 characters, so seven fit beside the short last turn.
    const long = "x".repeat(20_000);
    const events = log(
      ...Array.from({ length: 10 }, (_, index) => [
        turn(`m${index}`, `ask ${index} ${long}`),
        ...reply("ok"),
      ]).flat(),
      turn("last", "the last one"),
      ...reply("done"),
    );
    const { older, recent } = splitConversation(exchanges(events));
    assert.lengthOf(older, 3);
    assert.lengthOf(recent, 8);
    const from = { provider: "claude" as const, model: "opus" };
    const condensed = handoffBrief(events, { from, summary: "They fixed the parser.", running: [] });
    assert.include(
      condensed,
      "## Earlier in the conversation (condensed from 3 turns)\n\nThey fixed the parser.",
    );
    assert.include(condensed, "## The latest 8 turns");
    assert.notInclude(condensed, "ask 2 ");
    const listed = handoffBrief(events, { from, running: [] });
    assert.include(listed, "## Earlier in the conversation (3 turns, not shown)");
    assert.include(listed, "The user's messages then:\n- ask 0 xxx");
  });

  it("leaves earlier briefs out of the conversation it tells again", () => {
    const events = log(
      {
        _tag: "TurnInput",
        items: [
          { _tag: "SystemNotice", text: `${HANDOFF_PREFACE} old brief` },
          { _tag: "FromUser", id: "m2", text: "go on" },
        ],
        turnId: "t2",
      },
      ...reply("went on"),
    );
    const brief = handoffBrief(events, { from: { provider: "codex", model: "gpt" }, running: [] });
    assert.notInclude(brief, "old brief");
    assert.include(brief, "go on");
  });

  it("is owed until the new session's first turn", () => {
    assert.deepStrictEqual(pendingHandoff(log(turn("m1", "one"), ...reply("a"), handedOff)), handedOff);
    assert.isUndefined(pendingHandoff(log(handedOff, turn("m2", "two"))));
    assert.isTrue(startsAnew(log(turn("m1", "one"), handedOff)));
    assert.isFalse(
      startsAnew(
        log(handedOff, {
          _tag: "SessionStarted",
          provider: "codex",
          providerSessionId: "s",
          model: "gpt-6-luna",
        }),
      ),
    );
  });

  it("replays to go back to before a handoff, and counts from it after", () => {
    const events = log(
      turn("m1", "one"),
      ...reply("first"),
      turn("m2", "two"),
      ...reply("second"),
      handedOff,
      turn("m3", "three"),
      ...reply("third"),
      turn("m4", "four"),
    );
    assert.deepInclude(rewindPoint(events, "m2"), { via: "replay", turn: { index: 0, id: "turn-m2" } });
    assert.deepInclude(rewindPoint(events, "m1"), { via: "fresh" });
    assert.deepInclude(rewindPoint(events, "m3"), { via: "replay" });
    assert.deepInclude(rewindPoint(events, "m4"), { via: "fork", turn: { index: 1, id: "turn-m4" } });
    // The rewind before "two" replays only "one".
    const rewound = log(...events.map(({ payload }) => payload), {
      _tag: "ConversationRewound",
      fromSequence: 3,
      messageId: "m2",
      via: "replay",
    });
    const notice = replayNotice(liveEvents(rewound)) ?? "";
    assert.include(notice, "[Input]\none");
    assert.notInclude(notice, "two");
  });
});

const turnsCompleted = (count: number, agentId: AgentId) => (events: ReadonlyArray<AgentEvent>) => {
  const done = events.filter((event) => event.agentId === agentId && event.payload._tag === "TurnCompleted");
  return done.length >= count ? done : undefined;
};

describe("Orchestrator handoff", () => {
  it.live("goes on in a new session on the other harness, told the conversation so far", () => {
    const claude = makeFakeAdapter("claude");
    const codex = makeFakeAdapter("codex");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* Store;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* orchestrator.createThread({
        title: "Test",
        mode: "work",
        cwd: ".",
        lead: { provider: "claude", model: "opus", effort: "high", access: "auto" },
      });
      yield* orchestrator.sendUserMessage(lead.id, "Fix the parser");
      yield* waitFor(turnsCompleted(1, lead.id));

      const moved = yield* orchestrator.handOffLead(lead.id, {
        provider: "codex",
        model: "gpt-6-luna",
        effort: "medium",
      });
      assert.deepStrictEqual([moved.provider, moved.model, moved.effort], ["codex", "gpt-6-luna", "medium"]);
      assert.isUndefined(moved.providerSessionId);
      const stored = (yield* orchestrator.listAgents(lead.threadId))[0];
      assert.deepStrictEqual([stored?.provider, stored?.model], ["codex", "gpt-6-luna"]);
      const handoff = (yield* store.listEvents(lead.id)).find(
        ({ payload }) => payload._tag === "LeadHandedOff",
      );
      assert.deepStrictEqual(handoff?.payload, {
        _tag: "LeadHandedOff",
        from: { provider: "claude", model: "opus" },
        provider: "codex",
        model: "gpt-6-luna",
        effort: "medium",
      });

      yield* orchestrator.sendUserMessage(lead.id, "Now the tests");
      yield* waitFor(turnsCompleted(2, lead.id));
      const session = codex.sessions[0];
      assert.isDefined(session);
      assert.isUndefined(session?.options.resume, "a new session, not the old harness's");
      assert.strictEqual(session?.options.model, "gpt-6-luna");
      const told = session?.sent[0] ?? "";
      assert.include(told, HANDOFF_PREFACE);
      assert.include(told, "[Input]\nFix the parser");
      assert.include(told, "reply to: Fix the parser");
      assert.isTrue(told.trimEnd().endsWith("Now the tests"), "the user's message follows the brief");
      assert.lengthOf(claude.sessions, 1);

      // Its next turn hears no brief again.
      yield* orchestrator.sendUserMessage(lead.id, "And the docs");
      yield* waitFor(turnsCompleted(3, lead.id));
      assert.notInclude(session?.sent[1] ?? "", HANDOFF_PREFACE);
    }).pipe(Effect.provide(testLayer([claude.adapter, codex.adapter])), Effect.scoped);
  });

  it.live("condenses a long thread's older turns with the quick model", () => {
    const claude = makeFakeAdapter("claude", { reply: () => "y".repeat(7_000) });
    const codex = makeFakeAdapter("codex", { complete: () => "They fixed the parser." });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* orchestrator.createThread({
        title: "Test",
        mode: "chat",
        lead: { provider: "claude", model: "opus", access: "readOnly" },
      });
      for (let index = 1; index <= 9; index++) {
        yield* orchestrator.sendUserMessage(lead.id, `ask ${index}`);
        yield* waitFor(turnsCompleted(index, lead.id));
      }
      yield* orchestrator.handOffLead(lead.id, { provider: "codex", model: "gpt-6-luna" });
      yield* orchestrator.sendUserMessage(lead.id, "go on");
      yield* waitFor(turnsCompleted(10, lead.id));
      const told = codex.sessions[0]?.sent[0] ?? "";
      assert.include(told, "condensed from 2 turns)\n\nThey fixed the parser.");
      assert.notInclude(told, "[Input]\nask 1\n");
      assert.include(told, "[Input]\nask 9");
    }).pipe(Effect.provide(testLayer([claude.adapter, codex.adapter])), Effect.scoped);
  });

  it.live("refuses the lead's own harness, and one not installed", () => {
    const claude = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { lead } = yield* orchestrator.createThread({
        title: "Test",
        mode: "chat",
        lead: { provider: "claude", model: "opus", access: "readOnly" },
      });
      const same = yield* orchestrator
        .handOffLead(lead.id, { provider: "claude", model: "sonnet" })
        .pipe(Effect.flip);
      assert.strictEqual(same.reason, "invalid");
      const missing = yield* orchestrator
        .handOffLead(lead.id, { provider: "codex", model: "gpt-6-luna" })
        .pipe(Effect.flip);
      assert.strictEqual(missing.reason, "unavailable");
    }).pipe(Effect.provide(testLayer([claude.adapter])), Effect.scoped);
  });

  it.live("goes back to before the handoff by telling the new harness the conversation again", () => {
    const claude = makeFakeAdapter("claude");
    const codex = makeFakeAdapter("codex");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* Store;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* orchestrator.createThread({
        title: "Test",
        mode: "chat",
        lead: { provider: "claude", model: "opus", access: "readOnly" },
      });
      yield* orchestrator.sendUserMessage(lead.id, "one");
      yield* waitFor(turnsCompleted(1, lead.id));
      yield* orchestrator.sendUserMessage(lead.id, "two");
      yield* waitFor(turnsCompleted(2, lead.id));
      yield* orchestrator.handOffLead(lead.id, { provider: "codex", model: "gpt-6-luna" });
      yield* orchestrator.sendUserMessage(lead.id, "three");
      yield* waitFor(turnsCompleted(3, lead.id));

      const two = (yield* store.listEvents(lead.id)).flatMap(({ payload }) =>
        payload._tag === "TurnInput"
          ? payload.items.flatMap((item) => (item._tag === "FromUser" && item.text === "two" ? [item] : []))
          : [],
      )[0];
      yield* orchestrator.editMessage(lead.id, two?.id ?? "", "two, better");
      yield* waitFor(turnsCompleted(4, lead.id));
      assert.lengthOf(codex.sessions, 2, "a new session on the harness it was handed to");
      const told = codex.sessions[1]?.sent[0] ?? "";
      assert.include(told, "[Input]\none");
      assert.notInclude(told, HANDOFF_PREFACE);
      assert.isTrue(told.trimEnd().endsWith("two, better"));
      const rewound = (yield* store.listEvents(lead.id)).find(
        ({ payload }) => payload._tag === "ConversationRewound",
      );
      assert.deepInclude(rewound?.payload, { via: "replay" });
    }).pipe(Effect.provide(testLayer([claude.adapter, codex.adapter])), Effect.scoped);
  });
});
