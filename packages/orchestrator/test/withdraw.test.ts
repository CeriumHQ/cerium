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

/** One slow tool call for the first message only, so a message sent meanwhile waits behind it. */
const oneCall = (text: string): ReadonlyArray<EventPayload> =>
  text === "go"
    ? [
        { _tag: "ToolCallStarted", callId: "c1", toolName: "Bash", input: {} },
        { _tag: "ToolCallCompleted", callId: "c1", output: "ok", isError: false },
      ]
    : [];

const find =
  (agentId: AgentId, test: (payload: EventPayload) => boolean) => (events: ReadonlyArray<AgentEvent>) =>
    events.find((event) => event.agentId === agentId && test(event.payload));

/** The id Cerium gave the user's message with this text. */
const queuedId = (events: ReadonlyArray<AgentEvent>, text: string) => {
  for (const { payload } of events) {
    if (payload._tag === "MessageQueued" && payload.message.text === text) return payload.message.id ?? "";
  }
  return "";
};

describe("Orchestrator withdrawing a queued message", () => {
  it.live("takes back a message waiting behind a tool call, so no turn delivers it", () => {
    const fake = makeFakeAdapter("claude", { work: oneCall, workPause: Duration.millis(400) });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { seen, waitFor } = yield* recordEvents;
      const { lead } = yield* startThread;

      yield* orchestrator.sendUserMessage(lead.id, "go");
      yield* waitFor(find(lead.id, (payload) => payload._tag === "ToolCallStarted"));
      yield* orchestrator.sendUserMessage(lead.id, "never mind");
      const id = queuedId(seen, "never mind");

      assert.isTrue(yield* orchestrator.withdrawMessage(lead.id, id));
      assert.isFalse(yield* orchestrator.withdrawMessage(lead.id, id), "it was taken back already");
      yield* waitFor(find(lead.id, (payload) => payload._tag === "TurnCompleted"));
      assert.isTrue(
        seen.some((event) => event.payload._tag === "MessageWithdrawn" && event.payload.messageId === id),
      );
      assert.isFalse(
        seen.some(
          (event) => event.payload._tag === "TurnCompleted" && event.payload.stopReason === "steered",
        ),
        "nothing was left to steer the turn for",
      );
      assert.deepStrictEqual(fake.sessions[0]?.sent.length, 1);
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("won't take back a message a turn already delivered", () => {
    const fake = makeFakeAdapter("claude", {});
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { seen, waitFor } = yield* recordEvents;
      const { lead } = yield* startThread;

      yield* orchestrator.sendUserMessage(lead.id, "hello");
      yield* waitFor(find(lead.id, (payload) => payload._tag === "TurnCompleted"));

      assert.isFalse(yield* orchestrator.withdrawMessage(lead.id, queuedId(seen, "hello")));
      assert.isFalse(seen.some((event) => event.payload._tag === "MessageWithdrawn"));
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("takes back a stopped lead's waiting message, which its next session never hears", () => {
    const fake = makeFakeAdapter("claude", { work: oneCall, workPause: Duration.seconds(30) });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { seen, waitFor } = yield* recordEvents;
      const { lead } = yield* startThread;

      yield* orchestrator.sendUserMessage(lead.id, "go");
      yield* waitFor(find(lead.id, (payload) => payload._tag === "ToolCallStarted"));
      yield* orchestrator.sendUserMessage(lead.id, "drop this");
      yield* orchestrator.stopAgent(lead.id);

      assert.isTrue(yield* orchestrator.withdrawMessage(lead.id, queuedId(seen, "drop this")));
      yield* orchestrator.sendUserMessage(lead.id, "carry on");
      yield* waitFor(
        find(
          lead.id,
          (payload) =>
            payload._tag === "TurnInput" &&
            payload.items.some((item) => item._tag === "FromUser" && item.text === "carry on"),
        ),
      );
      const resumed = fake.sessions.at(-1)?.sent ?? [];
      assert.isTrue(resumed.some((sent) => sent.includes("carry on")));
      assert.isFalse(resumed.some((sent) => sent.includes("drop this")));
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });
});
