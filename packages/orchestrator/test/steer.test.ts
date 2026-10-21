import { makeFakeAdapter } from "@cerium/harness/testing";
import type { AgentEvent, AgentId, EventPayload } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect } from "effect";

import { Orchestrator } from "../src/index.ts";
import { recordEvents, testLayer } from "./fakes.ts";

const startThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator;
  return yield* orchestrator.createThread({
    title: "Test",
    mode: "chat",
    lead: { provider: "claude", model: "opus", access: "ask" },
  });
});

/** Two tool calls, one after the other, for the first message only. */
const twoCalls = (text: string): ReadonlyArray<EventPayload> =>
  text === "go"
    ? [
        { _tag: "ToolCallStarted", callId: "c1", toolName: "Bash", input: {} },
        { _tag: "ToolCallCompleted", callId: "c1", output: "ok", isError: false },
        { _tag: "ToolCallStarted", callId: "c2", toolName: "Bash", input: {} },
        { _tag: "ToolCallCompleted", callId: "c2", output: "ok", isError: false },
      ]
    : [];

const find =
  (agentId: AgentId, test: (payload: EventPayload) => boolean) => (events: ReadonlyArray<AgentEvent>) =>
    events.find((event) => event.agentId === agentId && test(event.payload));

const turnEnd = (stopReason: string) => (payload: EventPayload) =>
  payload._tag === "TurnCompleted" && payload.stopReason === stopReason;

describe("Orchestrator steering", () => {
  it.live("hands a message sent mid-turn to the agent once its tool call finishes", () => {
    const fake = makeFakeAdapter("claude", { work: twoCalls, workPause: Duration.millis(300) });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { seen, waitFor } = yield* recordEvents;
      const { lead } = yield* startThread;

      yield* orchestrator.sendUserMessage(lead.id, "go");
      yield* waitFor(find(lead.id, (payload) => payload._tag === "ToolCallStarted"));
      yield* orchestrator.sendUserMessage(lead.id, "change course");

      yield* waitFor(find(lead.id, turnEnd("steered")));
      yield* waitFor(find(lead.id, turnEnd("completed")));
      assert.deepStrictEqual(fake.sessions[0]?.sent.length, 2);
      assert.include(fake.sessions[0]?.sent[1], "change course");
      assert.isFalse(
        seen.some((event) => event.payload._tag === "ToolCallStarted" && event.payload.callId === "c2"),
        "the turn stopped before its next tool call",
      );
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("leaves a turn with nothing waiting to finish its tool calls", () => {
    const fake = makeFakeAdapter("claude", { work: twoCalls, workPause: Duration.millis(50) });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { seen, waitFor } = yield* recordEvents;
      const { lead } = yield* startThread;

      yield* orchestrator.sendUserMessage(lead.id, "go");
      yield* waitFor(find(lead.id, turnEnd("completed")));
      assert.isTrue(
        seen.some((event) => event.payload._tag === "ToolCallCompleted" && event.payload.callId === "c2"),
      );
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("steers at once when the user asks, without waiting for the tool call", () => {
    const fake = makeFakeAdapter("claude", { work: twoCalls, workPause: Duration.seconds(30) });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startThread;

      yield* orchestrator.sendUserMessage(lead.id, "go");
      yield* waitFor(find(lead.id, (payload) => payload._tag === "ToolCallStarted"));
      // Nothing waits yet: steering leaves the turn alone.
      yield* orchestrator.steerAgent(lead.id);
      yield* orchestrator.sendUserMessage(lead.id, "now");
      yield* orchestrator.steerAgent(lead.id);

      yield* waitFor(find(lead.id, turnEnd("steered")));
      yield* waitFor(find(lead.id, turnEnd("completed")));
      assert.deepStrictEqual(fake.sessions[0]?.sent.length, 2);
      assert.include(fake.sessions[0]?.sent[1], "now");
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });
});
