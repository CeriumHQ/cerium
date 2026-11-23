import { HarnessFailure } from "@cerium/harness";
import { makeFakeAdapter } from "@cerium/harness/testing";
import type { AgentId } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { MessageDelivery } from "../src/delivery.ts";
import { systemPrompt } from "../src/prompts.ts";
import { Orchestrator, UserSettings } from "../src/index.ts";
import { recordEvents, testLayer } from "./fakes.ts";

const a = "a" as AgentId;
const b = "b" as AgentId;
const start = (orchestrator: Orchestrator["Service"]) =>
  orchestrator.createThread({
    title: "Test",
    mode: "work",
    cwd: ".",
    lead: { provider: "claude", model: "opus", access: "fullAccess" },
  });
const scout = { alias: "scout", provider: "claude", model: "haiku", description: "Scout" } as const;

describe("message requests", () => {
  it("accepts only the addressed recipient's reply, once", () => {
    const delivery = new MessageDelivery();
    delivery.request({ id: "q", from: a, to: b, task: false });
    assert.isFalse(delivery.answer(a, b, "q"));
    assert.isTrue(delivery.waiting(a));
    assert.isTrue(delivery.answer(b, a, "q"));
    assert.isFalse(delivery.answer(b, a, "q"));
    assert.isFalse(delivery.waiting(a));
  });

  it("coalesces an assignment group and removes stopped agents' pending requests", () => {
    const delivery = new MessageDelivery();
    delivery.request({ id: "one", from: a, to: b, task: true, group: "g" });
    delivery.request({ id: "two", from: a, to: "c" as AgentId, task: true, group: "g" });
    const request = delivery.taskFor(b)!;
    delivery.answer(b, a, "one");
    assert.isTrue(delivery.groupPending(request));
    delivery.remove("c" as AgentId);
    assert.isFalse(delivery.groupPending(request));
  });

  it.live("100 cross-thread lead notes reach the next user turn without waking the recipient", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* start(orchestrator);
      const other = yield* start(orchestrator);
      for (let n = 0; n < 100; n++) {
        assert.isTrue((yield* orchestrator.sendMessage(other.lead.id, lead.id, `note ${n}`)).held);
      }
      yield* Effect.sleep("100 millis");
      assert.lengthOf(fake.sessions[0]!.sent, 0);
      yield* orchestrator.sendUserMessage(lead.id, "continue");
      yield* waitFor(() => fake.sessions[0]?.sent[0]);
      assert.include(fake.sessions[0]!.sent[0]!, "note 0");
      assert.include(fake.sessions[0]!.sent[0]!, "note 99");
    }).pipe(Effect.provide(testLayer([fake.adapter], { messageLimit: 110 })), Effect.scoped);
  });

  it.live("explicit replies wake their asker while notes leave the request open", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const first = yield* start(orchestrator);
      const second = yield* start(orchestrator);
      const requested = yield* orchestrator.sendMessage(first.lead.id, second.lead.id, "which file?", {
        kind: "request",
      });
      assert.isString(requested.requestId);
      yield* waitFor(() => (fake.sessions[1]?.sent.length ? true : undefined));
      assert.isTrue(
        (yield* orchestrator.sendMessage(second.lead.id, first.lead.id, "still checking", { kind: "note" }))
          .held,
      );
      const replied = yield* orchestrator.sendMessage(second.lead.id, first.lead.id, "app.ts", {
        kind: "reply",
        requestId: requested.requestId!,
      });
      assert.isFalse(replied.held);
      yield* waitFor(() => (fake.sessions[0]?.sent.length ? true : undefined));
      assert.include(fake.sessions[0]!.sent[0]!, "still checking");
      const duplicate = yield* Effect.flip(
        orchestrator.sendMessage(second.lead.id, first.lead.id, "app.ts", {
          kind: "reply",
          requestId: requested.requestId!,
        }),
      );
      assert.strictEqual(duplicate.reason, "invalid");
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live(
    "renders a private assignment as a task and prevents workers messaging their lead or siblings",
    () => {
      const fake = makeFakeAdapter("claude");
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator;
        const { waitFor } = yield* recordEvents;
        const { lead } = yield* start(orchestrator);
        const one = yield* orchestrator.spawn(lead.id, { model: "scout", role: "one", prompt: "inspect" });
        const two = yield* orchestrator.spawn(lead.id, { model: "scout", role: "two", prompt: "test" });
        if (one._tag !== "Spawned" || two._tag !== "Spawned") throw new Error("Expected children");
        const rendered = yield* waitFor(() => fake.sessions[1]?.sent[0]);
        assert.strictEqual(rendered, `[Cerium] Task from lead ${lead.id}:\ninspect`);
        const event = yield* waitFor((events) =>
          events.find((e) => e.agentId === one.agentId && e.payload._tag === "TurnInput"),
        );
        if (event.payload._tag !== "TurnInput") throw new Error("Expected input");
        const task = event.payload.items[0];
        if (task?._tag !== "FromAgent") throw new Error("Expected assignment");
        assert.match(task.requestId!, /^task_/);
        for (const to of [lead.id, two.agentId]) {
          assert.strictEqual(
            (yield* Effect.flip(
              orchestrator.sendMessage(one.agentId, to, "done", {
                kind: "reply",
                requestId: task.requestId!,
              }),
            )).reason,
            "notAllowed",
          );
        }
        assert.isFalse(fake.sessions[1]!.options.includeUserMcpServers);
        const childPrompt = fake.sessions[1]!.options.appendSystemPrompt!;
        for (const tool of [
          "answer_permission",
          "send_message",
          "list_threads",
          "spawn_agent",
          "continue_agent",
        ]) {
          assert.notInclude(childPrompt, tool);
        }
        assert.include(childPrompt, "ask_user");
        assert.include(childPrompt, lead.id);
        const worktree = { root: "/checkout", project: "/project", branch: "topic", base: "main" };
        const leadPrompt = systemPrompt(lead, "cerium", { worktree });
        assert.include(leadPrompt, "continue_agent");
        assert.include(leadPrompt, "/checkout");
        assert.notInclude(leadPrompt, "about to change files");
        assert.include(systemPrompt(lead, "cerium"), "about to change files");
      }).pipe(Effect.provide(testLayer([fake.adapter], { catalog: [scout] })), Effect.scoped);
    },
  );

  it.live("records helper calls and attributes their usage to the model that actually ran", () => {
    const fake = makeFakeAdapter("claude");
    const helper = makeFakeAdapter("codex");
    const adapter = {
      ...helper.adapter,
      complete: (request: Parameters<typeof fake.adapter.complete>[0]) =>
        Effect.sync(() => {
          request.onUsage?.({ inputTokens: 11, outputTokens: 2, cachedInputTokens: 3 });
          return "A short title";
        }),
    };
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* start(orchestrator);
      yield* (yield* UserSettings).update({
        titles: { enabled: true, model: { provider: "codex", model: "tiny" } },
      });
      yield* orchestrator.sendUserMessage(lead.id, "hello");
      const usage = yield* waitFor((events) =>
        events.find((e) => e.payload._tag === "UsageReported" && e.payload.purpose === "title"),
      );
      assert.strictEqual(usage.agentId, lead.id);
      assert.deepInclude(usage.payload, {
        provider: "codex",
        model: "tiny",
        inputTokens: 11,
        outputTokens: 2,
        purpose: "title",
      });
      const store = yield* Store;
      const calls = yield* store.listEvents(lead.id, { tags: ["HelperCallStarted"] });
      assert.lengthOf(calls, 1);
      const rows = yield* store.listSpendEvents(0, Date.now() + 1);
      assert.isTrue(
        rows.some((row) => row.provider === "codex" && row.model === "tiny" && row.inputTokens === 11),
      );
    }).pipe(Effect.provide(testLayer([fake.adapter, adapter])), Effect.scoped);
  });
  it.live("batches sibling assignments from one lead turn into one result turn", () => {
    const fake = makeFakeAdapter("claude", { turnDuration: "300 millis", reply: (text) => text });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* start(orchestrator);
      yield* orchestrator.sendUserMessage(lead.id, "parallel work");
      yield* waitFor(() => (fake.sessions[0]?.sent.length ? true : undefined));
      const one = yield* orchestrator.spawn(lead.id, { model: "scout", role: "one", prompt: "inspect one" });
      yield* Effect.sleep("150 millis");
      const two = yield* orchestrator.spawn(lead.id, { model: "scout", role: "two", prompt: "inspect two" });
      if (one._tag !== "Spawned" || two._tag !== "Spawned") throw new Error("Expected children");
      yield* waitFor((events) =>
        events.find(
          (e) =>
            e.agentId === one.agentId && e.payload._tag === "AgentStateChanged" && e.payload.state === "idle",
        ),
      );
      assert.lengthOf(fake.sessions[0]!.sent, 1, "the first result waits for its sibling");
      yield* waitFor(() => (fake.sessions[0]?.sent.length === 2 ? true : undefined));
      assert.include(fake.sessions[0]!.sent[1]!, "inspect one");
      assert.include(fake.sessions[0]!.sent[1]!, "inspect two");
      const store = yield* Store;
      const resultTurns = () =>
        store
          .listEvents(lead.id, { tags: ["TurnInput"] })
          .pipe(
            Effect.map((events) =>
              events.flatMap(({ payload }) => (payload._tag === "TurnInput" ? [payload.items] : [])),
            ),
          );
      assert.deepStrictEqual(
        (yield* resultTurns())[1]?.map((i) => i._tag),
        ["ChildFinishedTurn", "ChildFinishedTurn"],
      );
      yield* orchestrator.continueChild(lead.id, one.agentId, "inspect again");
      const three = yield* orchestrator.spawn(lead.id, {
        model: "scout",
        role: "three",
        prompt: "inspect three",
      });
      if (three._tag !== "Spawned") throw new Error("Expected child");
      yield* waitFor(() => fake.sessions[0]?.sent[2]);
      assert.lengthOf(fake.sessions[1]!.sent, 2);
      assert.strictEqual(fake.sessions[1]!.sent[1], `[Cerium] Task from lead ${lead.id}:\ninspect again`);
      const turns = yield* resultTurns();
      assert.lengthOf(turns, 3);
      assert.sameMembers(
        turns[2]!.map((i) => i._tag === "ChildFinishedTurn" && i.agentId),
        [one.agentId, three.agentId],
      );
      assert.isEmpty(yield* store.listEvents(lead.id, { tags: ["MessageHeld"] }));
    }).pipe(Effect.provide(testLayer([fake.adapter], { catalog: [scout] })), Effect.scoped);
  });

  it.live("stopping one sibling waits for the group's remaining child before waking the parent", () => {
    const fake = makeFakeAdapter("claude", { turnDuration: "300 millis" });
    const children = makeFakeAdapter("codex", { turnDuration: "1 second", reply: (text) => text });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* start(orchestrator);
      yield* orchestrator.sendUserMessage(lead.id, "parallel work");
      yield* waitFor(() => (fake.sessions[0]?.sent.length ? true : undefined));
      const one = yield* orchestrator.spawn(lead.id, { model: "scout", role: "one", prompt: "inspect one" });
      const two = yield* orchestrator.spawn(lead.id, { model: "scout", role: "two", prompt: "inspect two" });
      if (one._tag !== "Spawned" || two._tag !== "Spawned") throw new Error("Expected children");
      yield* waitFor(() => (children.sessions[1]?.sent.length ? true : undefined));
      yield* orchestrator.stopAgent(one.agentId);
      yield* waitFor((events) =>
        events.find((event) => event.agentId === lead.id && event.payload._tag === "TurnCompleted"),
      );
      yield* Effect.sleep("100 millis");
      assert.lengthOf(fake.sessions[0]!.sent, 1, "a stopped sibling must not wake the parent early");
      const before = yield* orchestrator.threadEvents((yield* orchestrator.agent(lead.id)).threadId);
      assert.isFalse(
        before.some(
          (event) =>
            event.agentId === lead.id &&
            event.payload._tag === "TurnInput" &&
            event.payload.items.some(
              (item) => item._tag === "SystemNotice" && item.text.includes(one.agentId),
            ),
        ),
      );
      yield* waitFor(() => (fake.sessions[0]?.sent.length === 2 ? true : undefined));
      assert.include(fake.sessions[0]!.sent[1]!, "inspect two");
    }).pipe(
      Effect.provide(
        testLayer([fake.adapter, children.adapter], { catalog: [{ ...scout, provider: "codex" }] }),
      ),
      Effect.scoped,
    );
  });

  it.live("continues only a live owned worker with a bounded prompt", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { lead } = yield* start(orchestrator);
      const other = yield* start(orchestrator);
      const one = yield* orchestrator.spawn(lead.id, { model: "scout", role: "one", prompt: "inspect" });
      if (one._tag !== "Spawned") throw new Error("Expected child");
      for (const [caller, target] of [
        [one.agentId, one.agentId],
        [lead.id, other.lead.id],
        [other.lead.id, one.agentId],
      ] as const) {
        assert.strictEqual(
          (yield* Effect.flip(orchestrator.continueChild(caller, target, "more"))).reason,
          "notAllowed",
        );
      }
      assert.strictEqual(
        (yield* Effect.flip(orchestrator.continueChild(lead.id, one.agentId, "x".repeat(8001)))).reason,
        "invalid",
      );
      yield* orchestrator.killChild(lead.id, one.agentId);
      assert.strictEqual(
        (yield* Effect.flip(orchestrator.continueChild(lead.id, one.agentId, "more"))).reason,
        "notFound",
      );
    }).pipe(Effect.provide(testLayer([fake.adapter], { catalog: [scout] })), Effect.scoped);
  });

  it.live("holds new requests at the thread wake limit without dropping them or blocking replies", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const first = yield* start(orchestrator);
      const second = yield* start(orchestrator);
      const third = yield* start(orchestrator);
      const question = yield* orchestrator.sendMessage(first.lead.id, second.lead.id, "first", {
        kind: "request",
      });
      const held = yield* orchestrator.sendMessage(first.lead.id, third.lead.id, "second", {
        kind: "request",
      });
      assert.isTrue(held.held);
      assert.include(held.reason!, "budget");
      assert.isFalse(
        (yield* orchestrator.sendMessage(second.lead.id, first.lead.id, "answer", {
          kind: "reply",
          requestId: question.requestId!,
        })).held,
      );
      yield* orchestrator.sendUserMessage(third.lead.id, "read the waiting request");
      yield* waitFor(() => (fake.sessions[2]?.sent.length ? true : undefined));
      assert.include(fake.sessions[2]!.sent[0]!, "second");
      yield* orchestrator.sendUserMessage(first.lead.id, "continue");
      assert.isFalse(
        (yield* orchestrator.sendMessage(first.lead.id, second.lead.id, "third", { kind: "request" })).held,
      );
    }).pipe(Effect.provide(testLayer([fake.adapter], { automaticWakeLimit: 1 })), Effect.scoped);
  });
  it.live("wakes the lead when a child cannot start instead of leaving its group waiting", () => {
    const fake = makeFakeAdapter("claude");
    const adapter = {
      ...fake.adapter,
      startSession: (options: Parameters<typeof fake.adapter.startSession>[0]) =>
        options.model === "haiku"
          ? Effect.fail(new HarnessFailure({ provider: "claude", message: "child unavailable", cause: null }))
          : fake.adapter.startSession(options),
    };
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* start(orchestrator);
      yield* orchestrator.spawn(lead.id, { model: "scout", role: "worker", prompt: "inspect" });
      yield* waitFor(() =>
        fake.sessions[0]?.sent.some((text) => text.includes("could not start")) ? true : undefined,
      );
      assert.include(fake.sessions[0]!.sent[0]!, "child unavailable");
    }).pipe(Effect.provide(testLayer([adapter], { catalog: [scout] })), Effect.scoped);
  });
  it.live("keeps a child assignment pending through a user question and unblocks a dismissal", () => {
    const fake = makeFakeAdapter("claude", { turnDuration: "100 millis" });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* start(orchestrator);
      const child = yield* orchestrator.spawn(lead.id, { model: "scout", role: "worker", prompt: "inspect" });
      if (child._tag !== "Spawned") throw new Error("Expected child");
      yield* waitFor(() => (fake.sessions[1]?.sent.length ? true : undefined));
      const question = yield* orchestrator.askUser(child.agentId, [
        { question: "Which module?", options: [], multiSelect: false, allowOther: true },
      ]);
      yield* Effect.sleep("200 millis");
      assert.lengthOf(fake.sessions[0]!.sent, 0, "a question is not task completion");
      yield* orchestrator.answerQuestion(child.agentId, question.requestId, { outcome: "dismissed" });
      yield* waitFor(() => (fake.sessions[0]?.sent.length ? true : undefined));
    }).pipe(Effect.provide(testLayer([fake.adapter], { catalog: [scout] })), Effect.scoped);
  });
});
