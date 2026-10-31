import { makeFakeAdapter } from "@cerium/harness/testing";
import type { AdvisorSettings, AgentEvent, AgentId, InputItem } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect } from "effect";

import { Orchestrator, UserSettings, type CatalogEntry } from "../src/index.ts";
import { recordEvents, testLayer } from "./fakes.ts";

const scout: CatalogEntry = { alias: "scout", provider: "claude", model: "haiku", description: "Lookups" };

const sage: AdvisorSettings = { enabled: true, model: { provider: "codex", model: "sage", effort: "max" } };

const inputsOf = (events: ReadonlyArray<AgentEvent>, agentId: AgentId): ReadonlyArray<InputItem> =>
  events.flatMap((event) =>
    event.agentId === agentId && event.payload._tag === "TurnInput" ? event.payload.items : [],
  );

const startWorkThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator;
  return yield* orchestrator.createThread({
    title: "Test",
    mode: "work",
    cwd: ".",
    lead: { provider: "claude", model: "opus", access: "auto" },
  });
});

const spawnScout = (leadId: AgentId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    const outcome = yield* orchestrator.spawn(leadId, { role: "scout", model: "scout", prompt: "go" });
    return outcome._tag === "Spawned" ? outcome.agentId : ("" as AgentId);
  });

describe("Advisor", () => {
  it.live("answers each agent's question on the model the user picked, read only, one a turn", () => {
    const lead = makeFakeAdapter("claude");
    const advisor = makeFakeAdapter("codex", {
      turnDuration: Duration.millis(30),
      reply: (text) => `advice on ${text.slice(text.lastIndexOf("\n") + 1)}`,
    });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const settings = yield* UserSettings;
      yield* settings.update({ advisor: sage });
      const { waitFor } = yield* recordEvents;
      const thread = yield* startWorkThread;
      const childId = yield* spawnScout(thread.lead.id);
      yield* waitFor((events) =>
        inputsOf(events, thread.lead.id).find((item) => item._tag === "ChildFinishedTurn"),
      );

      const fromLead = yield* orchestrator.askAdvisor(thread.lead.id, "why is the lead stuck");
      const fromChild = yield* orchestrator.askAdvisor(childId, "why is the scout stuck");
      assert.strictEqual(fromChild.advisorId, fromLead.advisorId, "a thread has one advisor");

      const isAnswer = (item: InputItem) => item._tag === "FromAgent" && item.agentId === fromLead.advisorId;
      const leadAnswer = yield* waitFor((events) => inputsOf(events, thread.lead.id).find(isAnswer));
      const childAnswer = yield* waitFor((events) => inputsOf(events, childId).find(isAnswer));
      assert.strictEqual(
        leadAnswer._tag === "FromAgent" ? leadAnswer.text : "",
        "advice on why is the lead stuck",
      );
      assert.strictEqual(
        childAnswer._tag === "FromAgent" ? childAnswer.text : "",
        "advice on why is the scout stuck",
      );

      const info = yield* orchestrator.agent(fromLead.advisorId);
      assert.deepInclude(info, {
        parentId: thread.lead.id,
        role: "advisor",
        provider: "codex",
        model: "sage",
        effort: "max",
        access: "readOnly",
      });
      assert.lengthOf(advisor.sessions, 1);
      assert.lengthOf(advisor.sessions[0]?.sent ?? [], 2, "each question is its own turn");
      assert.include(advisor.sessions[0]?.options.appendSystemPrompt ?? "", "this thread's advisor");
      assert.notInclude(advisor.sessions[0]?.options.appendSystemPrompt ?? "", "spawn_agent");
      // Agents started while the advisor is on are told about it.
      assert.include(lead.sessions[0]?.options.appendSystemPrompt ?? "", "`ask_advisor`");
      assert.include(lead.sessions[1]?.options.appendSystemPrompt ?? "", "`ask_advisor`");
    }).pipe(Effect.provide(testLayer([lead.adapter, advisor.adapter], { catalog: [scout] })), Effect.scoped);
  });

  it.live("refuses questions while it is off, and keeps the advisor from working", () => {
    const lead = makeFakeAdapter("claude");
    const advisor = makeFakeAdapter("codex");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const settings = yield* UserSettings;
      const thread = yield* startWorkThread;
      assert.notInclude(lead.sessions[0]?.options.appendSystemPrompt ?? "", "ask_advisor");

      const off = yield* Effect.flip(orchestrator.askAdvisor(thread.lead.id, "anyone?"));
      assert.strictEqual(off.reason, "unavailable");
      yield* settings.update({ advisor: { enabled: false, ...(sage.model ? { model: sage.model } : {}) } });
      assert.strictEqual(
        (yield* Effect.flip(orchestrator.askAdvisor(thread.lead.id, "now?"))).reason,
        "unavailable",
      );

      yield* settings.update({ advisor: sage });
      const { advisorId } = yield* orchestrator.askAdvisor(thread.lead.id, "help");
      const reasons = yield* Effect.forEach(
        [
          orchestrator.askAdvisor(advisorId, "asking myself"),
          orchestrator.sendMessage(advisorId, thread.lead.id, "let me do it").pipe(Effect.asVoid),
          orchestrator.sendMessage(thread.lead.id, advisorId, "around the tool").pipe(Effect.asVoid),
          orchestrator.spawn(advisorId, { role: "worker", model: "scout", prompt: "work" }),
          orchestrator.spawn(thread.lead.id, { role: "advisor", model: "scout", prompt: "impostor" }),
        ],
        (attempt) => Effect.flip(attempt).pipe(Effect.map((error) => error.reason)),
      );
      assert.deepStrictEqual(reasons, ["notAllowed", "notAllowed", "notAllowed", "notAllowed", "invalid"]);
    }).pipe(Effect.provide(testLayer([lead.adapter, advisor.adapter], { catalog: [scout] })), Effect.scoped);
  });

  it.live("tells the asker when the advisor stops before it answers, and moves to a new pick", () => {
    const lead = makeFakeAdapter("claude");
    const advisor = makeFakeAdapter("codex", { turnDuration: Duration.seconds(30) });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const settings = yield* UserSettings;
      yield* settings.update({ advisor: sage });
      const { waitFor } = yield* recordEvents;
      const thread = yield* startWorkThread;

      const first = yield* orchestrator.askAdvisor(thread.lead.id, "slow question");
      yield* waitFor((events) =>
        events.find(
          (event) =>
            event.agentId === first.advisorId &&
            event.payload._tag === "AgentStateChanged" &&
            event.payload.state === "running",
        ),
      );
      yield* orchestrator.stopAgent(first.advisorId);
      const notice = yield* waitFor((events) =>
        inputsOf(events, thread.lead.id).find((item) => item._tag === "SystemNotice"),
      );
      assert.include(notice._tag === "SystemNotice" ? notice.text : "", "ended before it answered");
      assert.notInclude(notice._tag === "SystemNotice" ? notice.text : "", "will not report back");

      yield* settings.update({ advisor: { enabled: true, model: { provider: "codex", model: "oracle" } } });
      const second = yield* orchestrator.askAdvisor(thread.lead.id, "again");
      assert.notStrictEqual(second.advisorId, first.advisorId);
      assert.strictEqual((yield* orchestrator.agent(second.advisorId)).model, "oracle");
    }).pipe(Effect.provide(testLayer([lead.adapter, advisor.adapter])), Effect.scoped);
  });
});
