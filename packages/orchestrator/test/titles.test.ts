import { makeFakeAdapter } from "@cerium/harness/testing";
import { Settings, type ThreadId } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Schema } from "effect";

import {
  cleanTitle,
  Orchestrator,
  titleModels,
  titlePrompt,
  UserSettings,
  type CatalogEntry,
} from "../src/index.ts";
import { recordEvents, testLayer } from "./fakes.ts";

const entry = (provider: CatalogEntry["provider"], model: string): CatalogEntry => ({
  alias: model,
  provider,
  model,
  description: model,
});

/** Every default title model, as if every harness were logged in. */
const everyHarness = [
  entry("claude", "haiku"),
  entry("codex", "gpt-6-luna"),
  entry("cursor", "composer-2.5"),
  entry("muse", "muse-spark-1.3-contributor"),
];

const startThread = (title: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    return yield* orchestrator.createThread({
      title,
      mode: "chat",
      lead: { provider: "claude", model: "opus", access: "readOnly" },
    });
  });

const titleOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    const threads = yield* orchestrator.listThreads;
    return threads.find((thread) => thread.id === threadId)?.title;
  });

describe("cleanTitle", () => {
  it("keeps the title from a reply's first line", () => {
    assert.strictEqual(cleanTitle("Fix the Vite reload loop"), "Fix the Vite reload loop");
    assert.strictEqual(cleanTitle("\n\nTitle: Fix the build.\nBecause…"), "Fix the build");
    assert.strictEqual(cleanTitle('"Thread drafts".'), "Thread drafts");
    assert.strictEqual(cleanTitle("## **Persist thread drafts**"), "Persist thread drafts");
    assert.strictEqual(cleanTitle("Why does Vite reload?"), "Why does Vite reload");
    assert.isUndefined(cleanTitle(' \n"" '));
  });

  it("cuts a long title at a word", () => {
    const title = cleanTitle("word ".repeat(30)) ?? "";
    assert.isAtMost(title.length, 80);
    assert.isTrue(title.endsWith("word"));
  });
});

describe("titleModels", () => {
  const lead = { provider: "claude", model: "opus" } as const;
  const offered =
    (...models: ReadonlyArray<string>) =>
    (choice: { readonly model: string }) =>
      models.includes(choice.model);

  it("tries the defaults the harnesses offer, best first, then the lead", () => {
    assert.deepStrictEqual(titleModels({ enabled: true }, offered("composer-2.5", "haiku"), lead), [
      { provider: "claude", model: "haiku" },
      { provider: "cursor", model: "composer-2.5" },
      lead,
    ]);
    assert.deepStrictEqual(titleModels({ enabled: true }, offered(), lead), [lead]);
  });

  it("asks only the model the user picked", () => {
    const model = { provider: "muse", model: "muse-spark-1.3" } as const;
    assert.deepStrictEqual(titleModels({ enabled: true, model }, offered("gpt-6-luna"), lead), [model]);
  });
});

describe("thread titles", () => {
  it("are on for settings from a backend that predates them", () => {
    const settings = Schema.decodeUnknownSync(Settings)({});
    assert.deepStrictEqual(settings.titles, { enabled: true });
  });

  it("frames the message as something to title, with its attachments", () => {
    const prompt = titlePrompt("Why is this slow?", ["trace.json"]);
    assert.include(prompt, "Don't answer it");
    assert.include(prompt, "<message>\nWhy is this slow?\n(Attached: trace.json)\n</message>");
  });

  it.live("names a new thread from its first message with the best model offered", () => {
    const claude = makeFakeAdapter("claude");
    const codex = makeFakeAdapter("codex", { complete: () => "**Title:** Weekend trip plan." });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { thread, lead } = yield* startThread("plan my weekend trip to");

      yield* orchestrator.sendUserMessage(lead.id, "plan my weekend trip to Lisbon");
      const renamed = yield* waitFor((events) =>
        events.find((event) => event.payload._tag === "ThreadRenamed"),
      );
      assert.deepStrictEqual(renamed.payload, { _tag: "ThreadRenamed", title: "Weekend trip plan" });
      assert.strictEqual(renamed.agentId, lead.id);
      assert.strictEqual(yield* titleOf(thread.id), "Weekend trip plan");

      // Haiku leads the defaults; logged out, it gives way to the next.
      assert.deepStrictEqual(
        claude.completions.map((request) => request.model),
        ["haiku"],
      );
      const [request] = codex.completions;
      assert.strictEqual(request?.model, "gpt-6-luna");
      assert.include(request?.prompt ?? "", "plan my weekend trip to Lisbon");

      // Only the first message names the thread, and the event isn't stored.
      yield* orchestrator.sendUserMessage(lead.id, "and book a hotel");
      yield* Effect.sleep(Duration.millis(50));
      assert.lengthOf(codex.completions, 1);
      const stored = yield* orchestrator.threadEvents(thread.id);
      assert.notInclude(
        stored.map((event) => event.payload._tag),
        "ThreadRenamed",
      );
    }).pipe(
      Effect.provide(testLayer([claude.adapter, codex.adapter], { catalog: everyHarness })),
      Effect.scoped,
    );
  });

  it.live("keeps the name the user gave while the title was being made", () => {
    const fake = makeFakeAdapter("claude", { complete: () => "Generated", completeDuration: "50 millis" });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { thread, lead } = yield* startThread("first line");
      yield* orchestrator.sendUserMessage(lead.id, "first line of a long message");
      yield* orchestrator.renameThread(thread.id, "Mine");
      yield* Effect.sleep(Duration.millis(150));
      assert.lengthOf(fake.completions, 1);
      assert.strictEqual(yield* titleOf(thread.id), "Mine");
    }).pipe(Effect.provide(testLayer([fake.adapter], { catalog: everyHarness })), Effect.scoped);
  });

  it.live("uses the model the user picked, and nothing while titles are off", () => {
    const fake = makeFakeAdapter("claude", { complete: () => "Picked" });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const settings = yield* UserSettings;
      const { waitFor } = yield* recordEvents;

      yield* settings.update({ titles: { enabled: true, model: { provider: "claude", model: "sonnet" } } });
      const first = yield* startThread("one");
      yield* orchestrator.sendUserMessage(first.lead.id, "one");
      yield* waitFor((events) => events.find((event) => event.payload._tag === "ThreadRenamed"));
      assert.deepStrictEqual(
        fake.completions.map((request) => request.model),
        ["sonnet"],
      );
      assert.strictEqual(yield* titleOf(first.thread.id), "Picked");

      yield* settings.update({ titles: { enabled: false } });
      const second = yield* startThread("two");
      yield* orchestrator.sendUserMessage(second.lead.id, "two");
      yield* Effect.sleep(Duration.millis(50));
      assert.lengthOf(fake.completions, 1);
      assert.strictEqual(yield* titleOf(second.thread.id), "two");
    }).pipe(Effect.provide(testLayer([fake.adapter], { catalog: everyHarness })), Effect.scoped);
  });

  it.live("keeps the first line when no model answers", () => {
    const fake = makeFakeAdapter("claude");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const { waitFor } = yield* recordEvents;
      const { thread, lead } = yield* startThread("hello there");
      yield* orchestrator.sendUserMessage(lead.id, "hello there");
      yield* waitFor(() => (fake.completions.length >= 2 ? true : undefined));
      // Haiku, then the lead's own model.
      assert.deepStrictEqual(
        fake.completions.map((request) => request.model),
        ["haiku", "opus"],
      );
      assert.strictEqual(yield* titleOf(thread.id), "hello there");
    }).pipe(Effect.provide(testLayer([fake.adapter], { catalog: everyHarness })), Effect.scoped);
  });
});
