import { HarnessFailure } from "@cerium/harness";
import { makeFakeAdapter } from "@cerium/harness/testing";
import type { AgentId } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { MessageDelivery } from "../src/delivery.ts";
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

  it.live("100 same-thread notes cause no extra turns and arrive with the next user turn", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* start(orchestrator);
      const spawned = yield* orchestrator.spawn(lead.id, {
        model: "scout",
        role: "worker",
        prompt: "inspect",
      });
      assert.strictEqual(spawned._tag, "Spawned");
      if (spawned._tag !== "Spawned") return;
      yield* waitFor(() =>
        fake.sessions[0]?.sent.length === 1 && fake.sessions[1]?.sent.length === 1 ? true : undefined,
      );
      yield* Effect.sleep("100 millis");
      for (let n = 0; n < 100; n++) {
        assert.isTrue((yield* orchestrator.sendMessage(spawned.agentId, lead.id, `note ${n}`)).held);
      }
      yield* Effect.sleep("100 millis");
      assert.lengthOf(fake.sessions[0]!.sent, 1);
      assert.lengthOf(fake.sessions[1]!.sent, 1);
      yield* orchestrator.sendUserMessage(lead.id, "continue");
      yield* waitFor(() => (fake.sessions[0]?.sent.length === 2 ? true : undefined));
      assert.include(fake.sessions[0]!.sent[1]!, "note 0");
      assert.include(fake.sessions[0]!.sent[1]!, "note 99");
    }).pipe(
      Effect.provide(testLayer([fake.adapter], { catalog: [scout], messageLimit: 110 })),
      Effect.scoped,
    ),
  );
  const fake = makeFakeAdapter("claude");

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

  it.live("a worker's explicit result produces no duplicate automatic completion", () => {
    const fake = makeFakeAdapter("claude", { turnDuration: "150 millis" });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* Store;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* start(orchestrator);
      const spawned = yield* orchestrator.spawn(lead.id, {
        model: "scout",
        role: "worker",
        prompt: "inspect",
      });
      if (spawned._tag !== "Spawned") return;
      yield* waitFor(() => (fake.sessions[1]?.sent.length ? true : undefined));
      const events = yield* store.listEvents(spawned.agentId, { tags: ["TurnInput"] });
      const input = events[0]?.payload;
      const assignment =
        input?._tag === "TurnInput" ? input.items.find((i) => i._tag === "FromAgent") : undefined;
      assert.isDefined(assignment);
      if (assignment?._tag !== "FromAgent") return;
      yield* orchestrator.sendMessage(spawned.agentId, lead.id, "done", {
        kind: "reply",
        requestId: assignment.requestId!,
      });
      yield* Effect.sleep("400 millis");
      const reports = yield* store.listEvents(lead.id, { tags: ["TurnInput"] });
      assert.lengthOf(reports, 1);
      assert.notInclude(
        reports.flatMap((e) => (e.payload._tag === "TurnInput" ? e.payload.items.map((i) => i._tag) : [])),
        "ChildFinishedTurn",
      );
      assert.isFalse(fake.sessions[1]!.options.includeUserMcpServers);
    }).pipe(Effect.provide(testLayer([fake.adapter], { catalog: [scout] })), Effect.scoped);
  });

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

  it.live("keeps an assignment open while its worker waits on a blocking answer", () => {
    const fake = makeFakeAdapter("claude", { turnDuration: "100 millis" });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* start(orchestrator);
      const child = yield* orchestrator.spawn(lead.id, { model: "scout", role: "worker", prompt: "inspect" });
      if (child._tag !== "Spawned") throw new Error("Expected child");
      yield* waitFor(() => (fake.sessions[1]?.sent.length ? true : undefined));
      const question = yield* orchestrator.sendMessage(child.agentId, lead.id, "which module?", {
        kind: "request",
      });
      yield* Effect.sleep("200 millis");
      const store = yield* Store;
      const before = yield* store.listEvents(lead.id, { tags: ["TurnInput"] });
      assert.isFalse(
        before.some(
          (e) =>
            e.payload._tag === "TurnInput" && e.payload.items.some((i) => i._tag === "ChildFinishedTurn"),
        ),
      );
      yield* orchestrator.sendMessage(lead.id, child.agentId, "the bus", {
        kind: "reply",
        requestId: question.requestId!,
      });
      yield* waitFor((events) =>
        events.find(
          (e) =>
            e.agentId === lead.id &&
            e.payload._tag === "TurnInput" &&
            e.payload.items.some((i) => i._tag === "ChildFinishedTurn"),
        ),
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
