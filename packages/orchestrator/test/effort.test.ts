import { makeFakeAdapter } from "@cerium/harness/testing";
import type { AgentEvent, AgentId, ModelInfo } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { effortState, likeliest, TURN_CHARS } from "../src/effort.ts";
import {
  EffortDecisionError,
  Orchestrator,
  UserSettings,
  type CatalogEntry,
  type EffortAnswer,
  type EffortDecider,
  type EffortQuestion,
} from "../src/index.ts";
import { recordEvents, testLayer } from "./fakes.ts";

const levels = ["low", "medium", "high"] as const;

const model = (id: string, cacheSafeEffort: boolean): ModelInfo => ({
  provider: "claude",
  id,
  label: id,
  efforts: [...levels],
  ...(cacheSafeEffort ? { cacheSafeEffort: true } : {}),
});

const models = [model("opus", true), model("claude-opus-5", false)];

const scout: CatalogEntry = {
  alias: "scout",
  provider: "claude",
  model: "opus",
  description: "Quick lookups",
};

/** A decision model that answers each question with the next of `answers`, and records the questions. */
const scripted = (answers: ReadonlyArray<EffortAnswer | string>) => {
  const asked: Array<EffortQuestion> = [];
  const decider: EffortDecider["Service"] = {
    ready: Effect.succeed(true),
    decide: (question) =>
      Effect.suspend(() => {
        const answer = answers[asked.length] ?? answers.at(-1);
        asked.push(question);
        return typeof answer === "string" || answer === undefined
          ? Effect.fail(new EffortDecisionError({ message: answer ?? "No answer." }))
          : Effect.succeed(answer);
      }),
  };
  return { decider, asked };
};

/** An answer sure of `level`. */
const sure = (level: (typeof levels)[number], confidence = 0.9, costUsd = 0.00002): EffortAnswer => ({
  probabilities: levels.map((each) => (each === level ? confidence : (1 - confidence) / 2)),
  confidence,
  costUsd,
});

const turnRouter = (enabled: boolean, children: "router" | "lead" = "router") =>
  Effect.gen(function* () {
    yield* (yield* UserSettings).update({ effortRouter: { enabled, children } });
  });

const startAutoLead = (modelId: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    return yield* orchestrator.createThread({
      title: "Test",
      mode: "work",
      cwd: ".",
      lead: { provider: "claude", model: modelId, effort: "medium", autoEffort: true, access: "auto" },
    });
  });

const turnsCompleted = (count: number, agentId: AgentId) => (events: ReadonlyArray<AgentEvent>) => {
  const done = events.filter((event) => event.agentId === agentId && event.payload._tag === "TurnCompleted");
  return done.length >= count ? done : undefined;
};

const routed = (events: ReadonlyArray<AgentEvent>, agentId: AgentId) =>
  events.flatMap((event) =>
    event.agentId === agentId && event.payload._tag === "EffortRouted" ? [event.payload] : [],
  );

describe("likeliest", () => {
  it("picks the most probable level, the lower one on a tie", () => {
    assert.strictEqual(likeliest(levels, [0.2, 0.7, 0.1]), "medium");
    assert.strictEqual(likeliest(levels, [0.4, 0.4, 0.2]), "low");
    assert.isUndefined(likeliest(levels, []));
  });
});

describe("effortState", () => {
  it("cuts the turn and keeps the last two exchanges", () => {
    const state = effortState(
      { from: "user", text: "x".repeat(TURN_CHARS + 50) },
      [1, 2, 3].map((n) => ({ sent: `sent ${n}`, replied: `replied ${n}` })),
      undefined,
    );
    assert.isBelow(state.turn.text.length, TURN_CHARS + 50);
    assert.deepStrictEqual(
      state.recent.map((exchange) => exchange.sent),
      ["sent 2", "sent 3"],
    );
  });
});

describe("Orchestrator effort routing", () => {
  it.live("routes every turn of an Auto lead on a cache-safe model", () => {
    const fake = makeFakeAdapter("claude");
    const { decider, asked } = scripted([sure("low"), sure("high")]);
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* Store;
      const { waitFor } = yield* recordEvents;
      yield* turnRouter(true);
      const { lead } = yield* startAutoLead("opus");
      yield* orchestrator.sendUserMessage(lead.id, "rename a variable");
      yield* waitFor(turnsCompleted(1, lead.id));
      yield* orchestrator.sendUserMessage(lead.id, "now redesign the whole module");
      yield* waitFor(turnsCompleted(2, lead.id));

      assert.deepStrictEqual(fake.sessions[0]?.switches, [{ effort: "low" }, { effort: "high" }]);
      const decisions = routed(yield* store.listEvents(lead.id), lead.id);
      assert.deepStrictEqual(
        decisions.map(({ effort, kept, confidence }) => ({ effort, kept, confidence })),
        [
          { effort: "low", kept: undefined, confidence: 0.9 },
          { effort: "high", kept: undefined, confidence: 0.9 },
        ],
      );
      assert.strictEqual(decisions[0]?.costUsd, 0.00002);
      // The second question reads the first exchange, and how that turn went.
      assert.strictEqual(asked[1]?.state.turn.text.includes("redesign"), true);
      assert.lengthOf(asked[1]?.state.recent ?? [], 1);
      assert.strictEqual(asked[1]?.state.previousTurn?.failed, false);
      const agent = yield* orchestrator.agent(lead.id);
      assert.deepStrictEqual([agent.effort, agent.autoEffort], ["high", true]);
    }).pipe(Effect.provide(testLayer([fake.adapter], { models, decider })), Effect.scoped);
  });

  it.live("keeps the level when the decision model is unsure or fails", () => {
    const fake = makeFakeAdapter("claude");
    const { decider } = scripted([sure("high", 0.3), "OpenRouter didn't accept the key."]);
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* Store;
      const { waitFor } = yield* recordEvents;
      yield* turnRouter(true);
      const { lead } = yield* startAutoLead("opus");
      yield* orchestrator.sendUserMessage(lead.id, "one");
      yield* waitFor(turnsCompleted(1, lead.id));
      yield* orchestrator.sendUserMessage(lead.id, "two");
      yield* waitFor(turnsCompleted(2, lead.id));

      assert.deepStrictEqual(fake.sessions[0]?.switches, []);
      const decisions = routed(yield* store.listEvents(lead.id), lead.id);
      assert.deepStrictEqual(
        decisions.map(({ effort, kept, detail }) => ({ effort, kept, detail })),
        [
          { effort: "medium", kept: "unsure", detail: undefined },
          { effort: "medium", kept: "failed", detail: "OpenRouter didn't accept the key." },
        ],
      );
    }).pipe(Effect.provide(testLayer([fake.adapter], { models, decider })), Effect.scoped);
  });

  it.live("routes only a new session's first turn on a model that restarts its cache", () => {
    const fake = makeFakeAdapter("claude");
    const { decider, asked } = scripted([sure("low")]);
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* Store;
      const { waitFor } = yield* recordEvents;
      yield* turnRouter(true);
      const { lead } = yield* startAutoLead("claude-opus-5");
      yield* orchestrator.sendUserMessage(lead.id, "one");
      yield* waitFor(turnsCompleted(1, lead.id));
      yield* orchestrator.sendUserMessage(lead.id, "two");
      yield* waitFor(turnsCompleted(2, lead.id));

      assert.lengthOf(asked, 1);
      assert.deepStrictEqual(fake.sessions[0]?.switches, [{ effort: "low" }]);
      const decisions = routed(yield* store.listEvents(lead.id), lead.id);
      assert.deepStrictEqual(
        decisions.map(({ effort, kept }) => ({ effort, kept })),
        [
          { effort: "low", kept: undefined },
          { effort: "low", kept: "cache" },
        ],
      );
    }).pipe(Effect.provide(testLayer([fake.adapter], { models, decider })), Effect.scoped);
  });

  it.live("does nothing while the router is off, and a picked effort takes the agent off Auto", () => {
    const fake = makeFakeAdapter("claude");
    const { decider, asked } = scripted([sure("low")]);
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startAutoLead("opus");
      yield* orchestrator.sendUserMessage(lead.id, "one");
      yield* waitFor(turnsCompleted(1, lead.id));
      assert.lengthOf(asked, 0);

      const picked = yield* orchestrator.switchModel(lead.id, { model: "opus", effort: "high" });
      assert.deepStrictEqual([picked.effort, picked.autoEffort], ["high", undefined]);
      const auto = yield* orchestrator.switchModel(lead.id, { model: "opus", autoEffort: true });
      assert.deepStrictEqual([auto.effort, auto.autoEffort], ["high", true]);
    }).pipe(Effect.provide(testLayer([fake.adapter], { models, decider })), Effect.scoped);
  });

  it.live("puts an Auto lead's children on Auto, or at its level, as the setting says", () => {
    const fake = makeFakeAdapter("claude");
    const { decider } = scripted([sure("low")]);
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      yield* turnRouter(true, "router");
      const { lead } = yield* startAutoLead("opus");
      const routedChild = yield* orchestrator.spawn(lead.id, { role: "a", model: "scout", prompt: "go" });
      const explicit = yield* orchestrator.spawn(lead.id, {
        role: "b",
        model: "scout",
        effort: "high",
        prompt: "go",
      });
      yield* turnRouter(true, "lead");
      const following = yield* orchestrator.spawn(lead.id, { role: "c", model: "scout", prompt: "go" });

      const info = (outcome: typeof routedChild) =>
        orchestrator.agent(outcome._tag === "Spawned" ? outcome.agentId : ("" as AgentId));
      const a = yield* info(routedChild);
      const b = yield* info(explicit);
      const c = yield* info(following);
      assert.deepStrictEqual([a.autoEffort, b.autoEffort, b.effort], [true, undefined, "high"]);
      assert.deepStrictEqual([c.autoEffort, c.effort], [undefined, "medium"]);
    }).pipe(Effect.provide(testLayer([fake.adapter], { models, decider, catalog: [scout] })), Effect.scoped);
  });
});
