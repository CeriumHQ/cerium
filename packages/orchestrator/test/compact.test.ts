import { makeFakeAdapter } from "@cerium/harness/testing";
import type { AgentEvent, AgentId, EventPayload } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Exit } from "effect";

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

const find =
  (agentId: AgentId, test: (payload: EventPayload) => boolean) => (events: ReadonlyArray<AgentEvent>) =>
    events.find((event) => event.agentId === agentId && test(event.payload));

const idle = (payload: EventPayload) => payload._tag === "AgentStateChanged" && payload.state === "idle";

describe("Orchestrator compaction", () => {
  it.live("runs a compaction the user asked for as a turn of its own, with no input", () => {
    const fake = makeFakeAdapter("claude", {
      compact: { trigger: "manual", tokensBefore: 9_000, tokensAfter: 2_000 },
      turnDuration: Duration.millis(50),
    });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { seen, waitFor } = yield* recordEvents;
      const { lead } = yield* startThread;

      yield* orchestrator.sendUserMessage(lead.id, "hello");
      yield* waitFor(find(lead.id, (payload) => payload._tag === "TurnCompleted"));
      yield* waitFor(find(lead.id, idle));
      const before = seen.length;

      yield* orchestrator.compactAgent(lead.id);
      yield* waitFor((events) =>
        events.slice(before).find((event) => event.agentId === lead.id && idle(event.payload)),
      );
      const compaction = seen.slice(before).map((event) => event.payload);
      assert.strictEqual(fake.compactions.count, 1);
      assert.deepInclude(compaction, {
        _tag: "ContextCompacted",
        trigger: "manual",
        tokensBefore: 9_000,
        tokensAfter: 2_000,
      });
      assert.deepInclude(compaction, { _tag: "AgentStateChanged", state: "running" });
      assert.isFalse(
        compaction.some((payload) => payload._tag === "TurnInput"),
        "a compaction delivers nothing",
      );
      assert.deepStrictEqual(fake.sessions[0]?.sent.length, 1);
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("holds a message sent during a compaction until it ends", () => {
    const fake = makeFakeAdapter("claude", {
      compact: { trigger: "manual" },
      turnDuration: Duration.millis(200),
    });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { seen, waitFor } = yield* recordEvents;
      const { lead } = yield* startThread;

      yield* orchestrator.sendUserMessage(lead.id, "hello");
      yield* waitFor(find(lead.id, idle));
      yield* orchestrator.compactAgent(lead.id);
      yield* orchestrator.sendUserMessage(lead.id, "after");
      yield* waitFor((events) => events.filter((event) => event.payload._tag === "TurnInput").at(1));
      yield* waitFor((events) => events.filter((event) => event.payload._tag === "TurnCompleted").at(2));

      const tags = seen.map((event) => event.payload._tag);
      const compacted = tags.indexOf("ContextCompacted");
      const second = tags.lastIndexOf("TurnInput");
      assert.isTrue(compacted !== -1 && compacted < second, "the message waited for the compaction");
      assert.deepStrictEqual(fake.running.max, 1);
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("refuses while the agent works, and on a harness that can't compact", () => {
    const compacting = makeFakeAdapter("claude", {
      compact: { trigger: "manual" },
      turnDuration: Duration.seconds(30),
    });
    const plain = makeFakeAdapter("codex");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startThread;
      const other = yield* orchestrator.createThread({
        title: "Other",
        mode: "chat",
        lead: { provider: "codex", model: "fake-model", access: "ask" },
      });

      yield* orchestrator.sendUserMessage(lead.id, "long");
      yield* waitFor(find(lead.id, (payload) => payload._tag === "TurnInput"));
      const busy = yield* Effect.exit(orchestrator.compactAgent(lead.id));
      assert.isTrue(Exit.isFailure(busy));

      yield* orchestrator.sendUserMessage(other.lead.id, "hi");
      yield* waitFor(find(other.lead.id, idle));
      const unable = yield* Effect.exit(orchestrator.compactAgent(other.lead.id));
      assert.isTrue(Exit.isFailure(unable));
    }).pipe(Effect.provide(testLayer([compacting.adapter, plain.adapter])), Effect.scoped);
  });

  it.live("ends the compaction's turn with why when the harness refuses", () => {
    const fake = makeFakeAdapter("claude", { compact: "fail" });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { seen, waitFor } = yield* recordEvents;
      const { lead } = yield* startThread;

      yield* orchestrator.sendUserMessage(lead.id, "hello");
      yield* waitFor(find(lead.id, idle));
      yield* orchestrator.compactAgent(lead.id);
      yield* waitFor(
        find(lead.id, (payload) => payload._tag === "TurnCompleted" && payload.stopReason === "error"),
      );
      assert.isTrue(
        seen.some(
          (event) =>
            event.payload._tag === "AgentError" && event.payload.message.includes("Nothing to compact."),
        ),
      );
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });
});
