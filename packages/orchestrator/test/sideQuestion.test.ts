import { makeFakeAdapter } from "@cerium/harness/testing";
import type { AgentEvent, EventPayload } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Exit } from "effect";

import { Orchestrator } from "../src/index.ts";
import { conversationPrompt, forkPrompt, SIDE_INSTRUCTIONS, sideInstructions } from "../src/sideQuestion.ts";
import { recordEvents, testLayer } from "./fakes.ts";

const log = (...payloads: ReadonlyArray<EventPayload>): ReadonlyArray<AgentEvent> =>
  payloads.map(
    (payload, sequence) =>
      ({ id: `a:${sequence}`, threadId: "t", agentId: "a", sequence, at: sequence, payload }) as AgentEvent,
  );

const turn = (id: string, text: string): EventPayload => ({
  _tag: "TurnInput",
  items: [{ _tag: "FromUser", id, text }],
  turnId: `turn-${id}`,
});

/** The completions that carry a side question; the thread's own title is asked for too. */
const answering = (completions: ReadonlyArray<{ readonly prompt: string }>, question: string) =>
  completions.filter((request) => request.prompt.includes(question));

const startThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator;
  return yield* orchestrator.createThread({
    title: "Test",
    mode: "chat",
    lead: { provider: "claude", model: "opus", access: "ask" },
  });
});

describe("side question prompts", () => {
  it("tells the copy when the agent is still at work", () => {
    assert.strictEqual(sideInstructions(false), SIDE_INSTRUCTIONS);
    assert.include(sideInstructions(true), "working on the user's latest request right now");
  });

  it("says in the question that the agent is still at work", () => {
    assert.include(forkPrompt("Why?", [], true), "still working on the user's latest request");
    assert.notInclude(forkPrompt("Why?", []), "still working");
    assert.include(conversationPrompt([], "Why?", [], true), "still working on the user's latest request");
  });

  it("puts earlier side questions before the new one", () => {
    const prompt = forkPrompt("And the second?", [{ question: "First?", answer: "One." }]);
    assert.include(prompt, "<earlier_side_questions>\nQ: First?\nA: One.\n</earlier_side_questions>");
    assert.isTrue(prompt.endsWith("And the second?"));
  });

  it("tells a completion the conversation word for word, then the question", () => {
    const prompt = conversationPrompt(
      log(turn("m1", "Fix the parser"), {
        _tag: "MessageCompleted",
        messageId: "r1",
        text: "Fixed it in src/parse.ts.",
      }),
      "Which file?",
      [],
    );
    assert.include(prompt, "[Input]\nFix the parser");
    assert.include(prompt, "[You]\nFixed it in src/parse.ts.");
    assert.isTrue(prompt.endsWith("Which file?"));
  });

  it("says so when there is no conversation yet, and when old turns are left out", () => {
    assert.include(conversationPrompt([], "Hi?", []), "There is no conversation yet.");
    const long = "x".repeat(5_000);
    const turns = Array.from({ length: 12 }, (_, index) => [
      turn(`m${index}`, long),
      { _tag: "MessageCompleted", messageId: `r${index}`, text: long } satisfies EventPayload,
    ]).flat();
    assert.match(conversationPrompt(log(...turns), "Hi?", []), /\(\d+ earlier turns are left out\.\)/);
  });
});

describe("Orchestrator side questions", () => {
  it.live("asks a copy of the lead's session while the lead is mid-turn and records nothing", () => {
    const fake = makeFakeAdapter("claude", {
      turnDuration: Duration.millis(500),
      sideQuestion: () => "It is the parser.",
    });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { seen, waitFor } = yield* recordEvents;
      const { lead } = yield* startThread;
      yield* orchestrator.sendUserMessage(lead.id, "Fix the parser");
      yield* waitFor((events) => events.find((event) => event.payload._tag === "SessionStarted"));
      const before = seen.length;

      const answer = yield* orchestrator.askSideQuestion(lead.id, "What are you on?", []);

      assert.strictEqual(answer, "It is the parser.");
      assert.strictEqual(fake.sideQuestions.length, 1);
      // The lead is mid-turn, which the copy is told.
      assert.strictEqual(fake.sideQuestions[0]?.instructions, sideInstructions(true));
      assert.include(fake.sideQuestions[0]?.prompt ?? "", "What are you on?");
      assert.strictEqual(answering(fake.completions, "What are you on?").length, 0);
      // The lead's session heard nothing of it, and the transcript gained no event.
      assert.deepStrictEqual(fake.sessions[0]?.sent, ["Fix the parser"]);
      assert.isFalse(
        seen
          .slice(before)
          .some((event) => event.payload._tag === "TurnInput" || event.payload._tag === "MessageCompleted"),
      );
    }).pipe(Effect.provide(testLayer([fake.adapter])));
  });

  it.live("tells a completion the conversation when the harness can't copy the session", () => {
    const fake = makeFakeAdapter("claude", {
      turnDuration: Duration.millis(10),
      reply: () => "Parser fixed.",
      complete: () => "Parser fixed, in src/parse.ts.",
    });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startThread;
      yield* orchestrator.sendUserMessage(lead.id, "Fix the parser");
      yield* waitFor((events) => events.find((event) => event.payload._tag === "TurnCompleted"));

      const answer = yield* orchestrator.askSideQuestion(lead.id, "What did you do?", []);

      assert.strictEqual(answer, "Parser fixed, in src/parse.ts.");
      const request = answering(fake.completions, "What did you do?")[0];
      assert.include(request?.prompt ?? "", "[Input]\nFix the parser");
      assert.include(request?.prompt ?? "", "[You]\nParser fixed.");
      assert.include(request?.prompt ?? "", "What did you do?");
    }).pipe(Effect.provide(testLayer([fake.adapter])));
  });

  it.live("falls back to the conversation when the copy fails", () => {
    const fake = makeFakeAdapter("claude", {
      turnDuration: Duration.millis(10),
      sideQuestion: "fail",
      complete: () => "From the text.",
    });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startThread;
      yield* orchestrator.sendUserMessage(lead.id, "Hello");
      yield* waitFor((events) => events.find((event) => event.payload._tag === "TurnCompleted"));

      const answer = yield* orchestrator.askSideQuestion(lead.id, "Why?", []);

      assert.strictEqual(answer, "From the text.");
      assert.strictEqual(fake.sideQuestions.length, 1);
      assert.strictEqual(answering(fake.completions, "Why?").length, 1);
    }).pipe(Effect.provide(testLayer([fake.adapter])));
  });

  it.live("refuses an agent that is not a lead, or that does not exist", () => {
    const fake = makeFakeAdapter("claude", { complete: () => "x" });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const missing = yield* Effect.exit(orchestrator.askSideQuestion("agt_none" as never, "Hi?", []));
      assert.isTrue(Exit.isFailure(missing));
    }).pipe(Effect.provide(testLayer([fake.adapter])));
  });
});
