import { makeFakeAdapter } from "@cerium/harness/testing";
import type { AgentEvent, AgentId, InputItem, Question } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect } from "effect";

import { Orchestrator, type CatalogEntry } from "../src/index.ts";
import { answerNotice, answerProblem, questionProblem, tidyResponse } from "../src/questions.ts";
import { recordEvents, testLayer } from "./fakes.ts";

const colour: Question = {
  header: "Colour",
  question: "Which colour do you prefer?",
  options: [{ label: "Red", description: "Bold" }, { label: "Blue" }],
  multiSelect: false,
  allowOther: true,
};
const finishes: Question = {
  question: "Which finishes?",
  options: [{ label: "Matte" }, { label: "Gloss" }],
  multiSelect: true,
  allowOther: false,
};

const scout: CatalogEntry = { alias: "scout", provider: "claude", model: "haiku", description: "Lookups" };

const startWorkThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator;
  return yield* orchestrator.createThread({
    title: "Test",
    mode: "work",
    cwd: ".",
    lead: { provider: "claude", model: "opus", access: "ask" },
  });
});

const askedOf = (events: ReadonlyArray<AgentEvent>) =>
  events.find((event) => event.payload._tag === "QuestionAsked");
const resolvedOf = (events: ReadonlyArray<AgentEvent>) =>
  events.find((event) => event.payload._tag === "QuestionResolved");
const inputsOf = (events: ReadonlyArray<AgentEvent>, agentId: AgentId): ReadonlyArray<InputItem> =>
  events.flatMap((event) =>
    event.agentId === agentId && event.payload._tag === "TurnInput" ? event.payload.items : [],
  );

describe("questionProblem", () => {
  it("refuses options that don't tell apart", () => {
    assert.include(
      questionProblem([{ ...colour, options: [{ label: "Red" }, { label: "red " }] }]) ?? "",
      "same option twice",
    );
  });
});

describe("answerProblem", () => {
  it("accepts picks from the options and words only where the question takes them", () => {
    assert.isUndefined(answerProblem([colour], [{ choices: ["Red"], text: "the dark one" }]));
    assert.isUndefined(answerProblem([colour], [{ choices: [], text: "teal" }]));
    assert.isUndefined(answerProblem([finishes], [{ choices: ["Matte", "Gloss"] }]));
  });

  it("explains what is wrong with an answer", () => {
    assert.include(answerProblem([colour, finishes], [{ choices: ["Red"] }]) ?? "", "2 parts");
    assert.include(answerProblem([colour], [{ choices: [] }]) ?? "", "Answer");
    assert.include(answerProblem([colour], [{ choices: ["Red", "Blue"] }]) ?? "", "takes one choice");
    assert.include(answerProblem([finishes], [{ choices: ["Matte", "Matte"] }]) ?? "", "twice");
    assert.include(
      answerProblem([finishes], [{ choices: ["Matte"], text: "and wax" }]) ?? "",
      "only the choices",
    );
  });
});

describe("answerNotice", () => {
  it("tells the agent each question with its answer", () => {
    const notice = answerNotice([colour, finishes], {
      outcome: "answered",
      answers: [{ choices: ["Blue"], text: "navy" }, { choices: ["Matte", "Gloss"] }],
    });
    assert.include(notice, "answered your questions");
    assert.include(notice, "- Which colour do you prefer?\n  Answer: Blue, navy");
    assert.include(notice, "- Which finishes?\n  Answer: Matte, Gloss");
  });

  it("keeps the user's words trimmed, and none where they wrote none", () => {
    assert.deepStrictEqual(
      tidyResponse({
        outcome: "answered",
        answers: [
          { choices: ["Red"], text: "  " },
          { choices: [], text: " teal " },
        ],
      }),
      { outcome: "answered", answers: [{ choices: ["Red"] }, { choices: [], text: "teal" }] },
    );
  });
});

describe("Questions through ask_user", () => {
  it.live("holds the question open after the turn, then tells the agent the answer as a notice", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { thread, lead } = yield* startWorkThread;

      const { requestId } = yield* orchestrator.askUser(lead.id, [colour, finishes]);
      const asked = yield* waitFor(askedOf);
      assert.deepStrictEqual(asked.payload, {
        _tag: "QuestionAsked",
        requestId,
        questions: [colour, finishes],
      });
      assert.isTrue(orchestrator.awaitingApproval(thread.id));
      const overview = (yield* orchestrator.threadOverviews).find((each) => each.thread.id === thread.id);
      assert.isTrue(overview?.awaitingApproval);

      yield* orchestrator.answerQuestion(lead.id, requestId, {
        outcome: "answered",
        answers: [{ choices: ["Red"], text: " the dark one " }, { choices: ["Matte"] }],
      });
      assert.isFalse(orchestrator.awaitingApproval(thread.id));
      const resolved = yield* waitFor(resolvedOf);
      assert.deepStrictEqual(resolved.payload, {
        _tag: "QuestionResolved",
        requestId,
        outcome: "answered",
        answers: [{ choices: ["Red"], text: "the dark one" }, { choices: ["Matte"] }],
      });
      // The answer wakes the agent: it arrives as the start of a turn, marked as the question's.
      const notice = yield* waitFor((events) =>
        inputsOf(events, lead.id).find(
          (item) => item._tag === "SystemNotice" && item.text.includes("Answer: Red"),
        ),
      );
      assert.strictEqual(notice._tag === "SystemNotice" && notice.questionId, requestId);
      yield* waitFor(() =>
        fake.sessions[0]?.sent.some((text) => text.includes("Answer: Red, the dark one")) ? true : undefined,
      );
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live(
    "tells a dismissal with the agent's next turn without starting one, and refuses an answer that doesn't fit",
    () => {
      const fake = makeFakeAdapter("claude");
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator;
        const { waitFor, seen } = yield* recordEvents;
        const { thread, lead } = yield* startWorkThread;
        const { requestId } = yield* orchestrator.askUser(lead.id, [colour]);
        const wrong = yield* Effect.flip(
          orchestrator.answerQuestion(lead.id, requestId, {
            outcome: "answered",
            answers: [{ choices: ["Green"] }],
          }),
        );
        assert.strictEqual(wrong.reason, "invalid");
        const unknown = yield* Effect.flip(
          orchestrator.answerQuestion(lead.id, "q_none", { outcome: "dismissed" }),
        );
        assert.strictEqual(unknown.reason, "notFound");

        yield* orchestrator.answerQuestion(lead.id, requestId, { outcome: "dismissed" });
        const resolved = yield* waitFor(resolvedOf);
        assert.deepStrictEqual(resolved.payload, {
          _tag: "QuestionResolved",
          requestId,
          outcome: "dismissed",
        });
        assert.isFalse(orchestrator.awaitingApproval(thread.id));
        const again = yield* Effect.flip(
          orchestrator.answerQuestion(lead.id, requestId, { outcome: "dismissed" }),
        );
        assert.strictEqual(again.reason, "notFound");

        // Well past the window notices wait in, no turn has started.
        yield* Effect.sleep(Duration.millis(100));
        assert.deepStrictEqual(inputsOf(seen, lead.id), []);

        // The user's next message carries it, ahead of their words.
        yield* orchestrator.sendUserMessage(lead.id, "carry on");
        const items = yield* waitFor((events) => {
          const inputs = inputsOf(events, lead.id);
          return inputs.length > 0 ? inputs : undefined;
        });
        assert.deepStrictEqual(
          items.map((item) => item._tag),
          ["SystemNotice", "FromUser"],
        );
        const [notice] = items;
        assert.strictEqual(notice?._tag === "SystemNotice" && notice.questionId, requestId);
        assert.include(
          notice?._tag === "SystemNotice" ? notice.text : "",
          `dismissed your question "${colour.question}"`,
        );
      }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
    },
  );

  it.live(
    "keeps a dismissal the agent hadn't heard when its session ends, for the session that resumes",
    () => {
      const fake = makeFakeAdapter("claude");
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator;
        const { waitFor, seen } = yield* recordEvents;
        const { lead } = yield* startWorkThread;
        const { requestId } = yield* orchestrator.askUser(lead.id, [colour]);
        yield* orchestrator.answerQuestion(lead.id, requestId, { outcome: "dismissed" });
        yield* orchestrator.stopAgent(lead.id);

        yield* orchestrator.sendUserMessage(lead.id, "carry on");
        const notice = yield* waitFor((events) =>
          inputsOf(events, lead.id).find(
            (item) => item._tag === "SystemNotice" && item.text.includes("dismissed your question"),
          ),
        );
        assert.strictEqual(notice._tag === "SystemNotice" && notice.questionId, requestId);
        // Heard once: neither the held copy nor a second turn repeats it.
        yield* Effect.sleep(Duration.millis(100));
        const told = inputsOf(seen, lead.id).filter(
          (item) => item._tag === "SystemNotice" && item.text.includes("dismissed your question"),
        );
        assert.strictEqual(told.length, 1);
        void fake;
      }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
    },
  );

  it.live("closes the question as expired when the agent is interrupted", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { thread, lead } = yield* startWorkThread;
      const { requestId } = yield* orchestrator.askUser(lead.id, [colour]);
      yield* orchestrator.interruptAgent(lead.id);
      const resolved = yield* waitFor(resolvedOf);
      assert.deepStrictEqual(resolved.payload, { _tag: "QuestionResolved", requestId, outcome: "expired" });
      assert.isFalse(orchestrator.awaitingApproval(thread.id));
      const late = yield* Effect.flip(
        orchestrator.answerQuestion(lead.id, requestId, { outcome: "dismissed" }),
      );
      assert.strictEqual(late.reason, "notFound");
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("closes the question as expired when the agent is stopped, and tells it when it comes back", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* Store;
      const { waitFor } = yield* recordEvents;
      const { thread, lead } = yield* startWorkThread;
      const { requestId } = yield* orchestrator.askUser(lead.id, [colour]);

      yield* orchestrator.stopAgent(lead.id);
      assert.isFalse(orchestrator.awaitingApproval(thread.id));
      const stored = yield* store.listEvents(lead.id);
      assert.deepStrictEqual(
        stored.filter((event) => event.payload._tag === "QuestionResolved").map((event) => event.payload),
        [{ _tag: "QuestionResolved", requestId, outcome: "expired" }],
      );

      // The lead picks the thread back up: it hears its question went unanswered.
      yield* orchestrator.sendUserMessage(lead.id, "carry on");
      const notice = yield* waitFor((events) =>
        inputsOf(events, lead.id).find(
          (item) => item._tag === "SystemNotice" && item.text.includes("before the user answered"),
        ),
      );
      assert.include(notice.text, colour.question);
      void fake;
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("shows a child's question to the user like the lead's", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { thread, lead } = yield* startWorkThread;
      const spawned = yield* orchestrator.spawn(lead.id, {
        role: "painter",
        model: "scout",
        prompt: "paint it",
      });
      assert.strictEqual(spawned._tag, "Spawned");
      const childId = spawned._tag === "Spawned" ? spawned.agentId : lead.id;
      const { requestId } = yield* orchestrator.askUser(childId, [colour]);
      const asked = yield* waitFor(askedOf);
      assert.strictEqual(asked.agentId, childId);
      assert.isTrue(orchestrator.awaitingApproval(thread.id));
      yield* orchestrator.answerQuestion(childId, requestId, {
        outcome: "answered",
        answers: [{ choices: ["Red"] }],
      });
      yield* waitFor((events) =>
        inputsOf(events, childId).find(
          (item) => item._tag === "SystemNotice" && item.text.includes("Answer: Red"),
        ),
      );
    }).pipe(Effect.provide(testLayer([fake.adapter], { catalog: [scout] })), Effect.scoped);
  });

  it.live("limits how many an agent keeps waiting, and refuses ones that can't be answered", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { lead } = yield* startWorkThread;
      const unanswerable = yield* Effect.flip(
        orchestrator.askUser(lead.id, [
          { question: "Well?", options: [], multiSelect: false, allowOther: false },
        ]),
      );
      assert.strictEqual(unanswerable.reason, "invalid");
      for (let count = 0; count < 4; count++) yield* orchestrator.askUser(lead.id, [colour]);
      const fifth = yield* Effect.flip(orchestrator.askUser(lead.id, [colour]));
      assert.strictEqual(fifth.reason, "budgetExceeded");
      const missing = yield* Effect.flip(orchestrator.askUser("agt_none" as AgentId, [colour]));
      assert.strictEqual(missing.reason, "notFound");
      void fake;
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });
});
