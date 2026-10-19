import { makeFakeAdapter } from "@cerium/harness/testing";
import type { AgentEvent, AgentId } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { Orchestrator, type CatalogEntry } from "../src/index.ts";
import { recordEvents, testLayer } from "./fakes.ts";

const scout: CatalogEntry = {
  alias: "scout",
  provider: "claude",
  model: "haiku",
  effort: "low",
  description: "Quick lookups",
};

const startWorkThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator;
  return yield* orchestrator.createThread({
    title: "Test",
    mode: "work",
    cwd: ".",
    lead: { provider: "claude", model: "opus", effort: "high", access: "auto" },
  });
});

const turnsCompleted = (count: number, agentId: AgentId) => (events: ReadonlyArray<AgentEvent>) => {
  const done = events.filter((event) => event.agentId === agentId && event.payload._tag === "TurnCompleted");
  return done.length >= count ? done : undefined;
};

describe("Orchestrator model switching", () => {
  it.live("switches a lead's model and effort from its next turn, in the same session", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* Store;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startWorkThread;
      yield* orchestrator.sendUserMessage(lead.id, "one");
      yield* waitFor(turnsCompleted(1, lead.id));

      const switched = yield* orchestrator.switchModel(lead.id, { model: "sonnet", effort: "low" });
      assert.strictEqual(switched.model, "sonnet");
      assert.strictEqual(switched.effort, "low");
      assert.deepStrictEqual(fake.sessions[0]?.switches, [], "nothing changes until the next turn");
      const stored = (yield* orchestrator.listAgents(lead.threadId))[0];
      assert.deepStrictEqual([stored?.model, stored?.effort], ["sonnet", "low"]);
      const recorded = (yield* store.listEvents(lead.id)).at(-1)?.payload;
      assert.deepStrictEqual(recorded, { _tag: "ModelChanged", model: "sonnet", effort: "low" });

      // Picking what it already runs changes nothing, and no effort for the same model keeps its own.
      yield* orchestrator.switchModel(lead.id, { model: "sonnet", effort: "low" });
      assert.strictEqual((yield* orchestrator.switchModel(lead.id, { model: "sonnet" })).effort, "low");
      yield* orchestrator.sendUserMessage(lead.id, "two");
      yield* waitFor(turnsCompleted(2, lead.id));
      assert.lengthOf(fake.sessions, 1);
      assert.deepStrictEqual(fake.sessions[0]?.switches, [{ model: "sonnet" }, { effort: "low" }]);
      const changes = (yield* store.listEvents(lead.id)).filter(
        (event) => event.payload._tag === "ModelChanged",
      );
      assert.lengthOf(changes, 1);
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("starts a stopped lead's resumed session on the model picked while it was stopped", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* Store;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startWorkThread;
      yield* orchestrator.sendUserMessage(lead.id, "one");
      yield* waitFor(turnsCompleted(1, lead.id));
      yield* orchestrator.stopAgent(lead.id);

      // A model without an effort setting clears the effort.
      const switched = yield* orchestrator.switchModel(lead.id, { model: "haiku" });
      assert.isUndefined(switched.effort);
      const history = yield* store.listEvents(lead.id);
      assert.deepStrictEqual(history.at(-1)?.payload, { _tag: "ModelChanged", model: "haiku" });
      assert.strictEqual(history.at(-1)?.sequence, (history.at(-2)?.sequence ?? -1) + 1);

      yield* orchestrator.sendUserMessage(lead.id, "two");
      yield* waitFor(turnsCompleted(2, lead.id));
      const resumed = fake.sessions[1];
      assert.strictEqual(resumed?.options.resume, "fake-1");
      assert.strictEqual(resumed?.options.model, "haiku");
      assert.isUndefined(resumed?.options.effort);
      assert.deepStrictEqual(resumed?.switches, []);
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("refuses what the harness can't switch, and agents other than a thread's lead", () => {
    const fake = makeFakeAdapter("claude", { switching: { model: false, effort: true } });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { lead } = yield* startWorkThread;
      const model = yield* Effect.flip(
        orchestrator.switchModel(lead.id, { model: "sonnet", effort: "high" }),
      );
      assert.strictEqual(model.reason, "notAllowed");
      const effort = yield* orchestrator.switchModel(lead.id, { model: "opus", effort: "max" });
      assert.strictEqual(effort.effort, "max");

      const outcome = yield* orchestrator.spawn(lead.id, { role: "scout", model: "scout", prompt: "go" });
      const childId = outcome._tag === "Spawned" ? outcome.agentId : ("" as AgentId);
      const child = yield* Effect.flip(orchestrator.switchModel(childId, { model: "haiku", effort: "high" }));
      assert.strictEqual(child.reason, "notAllowed");
    }).pipe(Effect.provide(testLayer([fake.adapter], { catalog: [scout] })), Effect.scoped);
  });

  it.live("goes back to the session's model when the harness refuses the switch", () => {
    const fake = makeFakeAdapter("claude", { refuseSwitches: true });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startWorkThread;
      yield* orchestrator.switchModel(lead.id, { model: "sonnet", effort: "high" });
      yield* orchestrator.sendUserMessage(lead.id, "one");
      yield* waitFor(turnsCompleted(1, lead.id));

      const error = yield* waitFor((events) =>
        events.find((event) => event.agentId === lead.id && event.payload._tag === "AgentError"),
      );
      assert.include(error.payload._tag === "AgentError" ? error.payload.message : "", "sonnet");
      const agent = yield* orchestrator.agent(lead.id);
      assert.deepStrictEqual([agent.model, agent.effort], ["opus", "high"]);
      assert.deepStrictEqual(fake.sessions[0]?.sent, ["one"], "the turn still runs, on the old model");
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });
});
