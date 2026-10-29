import { makeFakeAdapter } from "@cerium/harness/testing";
import type { AgentEvent, AgentId, EventPayload, LimitPolicy } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Orchestrator, UserSettings, type CatalogEntry } from "../src/index.ts";
import { recordEvents, testLayer, testStore } from "./fakes.ts";

const codexEntry: CatalogEntry = {
  alias: "luna",
  provider: "codex",
  model: "gpt-6-luna",
  description: "Quick coding",
};

const startThread = (onLimit?: LimitPolicy) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator;
    return yield* orchestrator.createThread({
      title: "Test",
      mode: "work",
      cwd: ".",
      ...(onLimit ? { onLimit } : {}),
      lead: { provider: "claude", model: "opus", effort: "high", access: "auto" },
    });
  });

const tags = (events: ReadonlyArray<AgentEvent>, tag: EventPayload["_tag"]) =>
  events.filter((event) => event.payload._tag === tag);

const turnsCompleted = (count: number, agentId: AgentId) => (events: ReadonlyArray<AgentEvent>) => {
  const done = events.filter(
    (event) =>
      event.agentId === agentId &&
      event.payload._tag === "TurnCompleted" &&
      event.payload.stopReason === "completed",
  );
  return done.length >= count ? done : undefined;
};

describe("Orchestrator limits", () => {
  it.live("waits for the reset and goes on in the same session, once", () => {
    const fake = makeFakeAdapter("claude", {
      limit: (turn) =>
        turn === 1 ? { provider: "claude", resetsAt: Date.now() + 250, message: "out" } : undefined,
    });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* Store;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startThread("wait");
      yield* orchestrator.sendUserMessage(lead.id, "Build it");
      const paused = yield* waitFor((events) => tags(events, "LimitPaused")[0]);
      assert.deepInclude(paused.payload, {
        _tag: "LimitPaused",
        provider: "claude",
        reported: true,
        attempt: 1,
      });
      assert.lengthOf(fake.sessions[0]?.sent ?? [], 1, "nothing is sent while paused");

      yield* waitFor(turnsCompleted(1, lead.id));
      const history = yield* store.listEvents(lead.id);
      assert.lengthOf(tags(history, "LimitResumed"), 1);
      assert.deepEqual(tags(history, "LimitResumed")[0]?.payload, { _tag: "LimitResumed", by: "reset" });
      assert.lengthOf(fake.sessions, 1, "the same session");
      assert.lengthOf(fake.sessions[0]?.sent ?? [], 2);
      assert.include(fake.sessions[0]?.sent[1] ?? "", "usage limit has reset");
      // It stays resumed: no second pause, no second resume.
      yield* Effect.sleep("300 millis");
      assert.lengthOf(tags(yield* store.listEvents(lead.id), "LimitResumed"), 1);
      assert.lengthOf(fake.sessions[0]?.sent ?? [], 2);
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("sends a message to a paused lead at once and ends the pause", () => {
    const fake = makeFakeAdapter("claude", {
      limit: (turn) =>
        turn === 1 ? { provider: "claude", resetsAt: Date.now() + 3_600_000, message: "out" } : undefined,
    });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* Store;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startThread("wait");
      yield* orchestrator.sendUserMessage(lead.id, "Build it");
      yield* waitFor((events) => tags(events, "LimitPaused")[0]);
      yield* orchestrator.sendUserMessage(lead.id, "Try now");
      yield* waitFor(turnsCompleted(1, lead.id));
      const history = yield* store.listEvents(lead.id);
      assert.deepEqual(
        tags(history, "LimitResumed").map((event) => event.payload),
        [{ _tag: "LimitResumed", by: "message" }],
      );
      assert.include(fake.sessions[0]?.sent[1] ?? "", "Try now");
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("keeps a pause across a restart and resumes the lead's session when it ends", () => {
    const fake = makeFakeAdapter("claude", {
      limit: (turn) =>
        turn === 1 ? { provider: "claude", resetsAt: Date.now() + 600, message: "out" } : undefined,
    });
    const database = join(mkdtempSync(join(tmpdir(), "cerium-limit-")), "cerium.db");
    return Effect.gen(function* () {
      const leadId = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator;
        const { waitFor } = yield* recordEvents;
        const { lead } = yield* startThread("wait");
        yield* orchestrator.sendUserMessage(lead.id, "Build it");
        yield* waitFor((events) => tags(events, "LimitPaused")[0]);
        return lead.id;
      }).pipe(Effect.provide(testLayer([fake.adapter], { database })), Effect.scoped);

      // The app was closed: the pause is still open in the lead's history.
      const closed = yield* Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.listEvents(leadId);
      }).pipe(Effect.provide(testStore(database)));
      assert.lengthOf(tags(closed, "LimitPaused"), 1);
      assert.lengthOf(tags(closed, "LimitResumed"), 0, "quitting doesn't end a pause");

      yield* Effect.gen(function* () {
        const { waitFor } = yield* recordEvents;
        yield* waitFor((events) => tags(events, "LimitResumed")[0]);
        yield* waitFor(turnsCompleted(1, leadId));
        const store = yield* Store;
        const history = yield* store.listEvents(leadId);
        assert.lengthOf(tags(history, "LimitResumed"), 1);
        assert.strictEqual(fake.sessions[1]?.options.resume, "fake-1");
        assert.include(fake.sessions[1]?.sent[0] ?? "", "usage limit has reset");
      }).pipe(Effect.provide(testLayer([fake.adapter], { database })), Effect.scoped);
    });
  });

  it.live("resumes at once on start when the reset came while the app was closed", () => {
    const fake = makeFakeAdapter("claude", {
      limit: (turn) =>
        turn === 1 ? { provider: "claude", resetsAt: Date.now() + 80, message: "out" } : undefined,
    });
    const database = join(mkdtempSync(join(tmpdir(), "cerium-limit-")), "cerium.db");
    return Effect.gen(function* () {
      const leadId = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator;
        const { waitFor } = yield* recordEvents;
        const { lead } = yield* startThread("wait");
        yield* orchestrator.sendUserMessage(lead.id, "Build it");
        yield* waitFor((events) => tags(events, "LimitPaused")[0]);
        return lead.id;
      }).pipe(Effect.provide(testLayer([fake.adapter], { database })), Effect.scoped);
      yield* Effect.sleep("200 millis");
      yield* Effect.gen(function* () {
        const { waitFor } = yield* recordEvents;
        yield* waitFor(turnsCompleted(1, leadId));
        const store = yield* Store;
        assert.lengthOf(tags(yield* store.listEvents(leadId), "LimitResumed"), 1);
      }).pipe(Effect.provide(testLayer([fake.adapter], { database })), Effect.scoped);
    });
  });

  it.live("a stopped lead doesn't resume on its own", () => {
    const fake = makeFakeAdapter("claude", {
      limit: (turn) =>
        turn === 1 ? { provider: "claude", resetsAt: Date.now() + 200, message: "out" } : undefined,
    });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* Store;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startThread("wait");
      yield* orchestrator.sendUserMessage(lead.id, "Build it");
      yield* waitFor((events) => tags(events, "LimitPaused")[0]);
      yield* orchestrator.stopAgent(lead.id);
      yield* Effect.sleep("400 millis");
      const history = yield* store.listEvents(lead.id);
      assert.deepEqual(
        tags(history, "LimitResumed").map((event) => event.payload),
        [{ _tag: "LimitResumed", by: "stopped" }],
      );
      assert.lengthOf(fake.sessions[0]?.sent ?? [], 1);
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("fails over to the next harness with the work so far, and doesn't go back", () => {
    const claude = makeFakeAdapter("claude", {
      work: () => [
        { _tag: "ToolCallStarted", callId: "c1", toolName: "Edit", input: { file_path: "src/a.ts" } },
      ],
      limit: () => ({ provider: "claude", message: "out" }),
    });
    const codex = makeFakeAdapter("codex");
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* Store;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startThread("failover");
      yield* orchestrator.sendUserMessage(lead.id, "Build it");
      yield* waitFor(turnsCompleted(1, lead.id));
      const history = yield* store.listEvents(lead.id);
      const handoff = tags(history, "LeadHandedOff")[0]?.payload;
      assert.deepInclude(handoff, {
        _tag: "LeadHandedOff",
        cause: "limit",
        provider: "codex",
        model: "gpt-6-luna",
      });
      const told = codex.sessions[0]?.sent[0] ?? "";
      assert.include(told, "ran out of usage in the middle of a turn");
      assert.include(told, "[Input]\nBuild it");
      assert.include(told, "What the cut-off turn had done");
      assert.include(told, "- Edit: src/a.ts");
      assert.include(told, "Carry on from where it stopped");
      assert.lengthOf(claude.sessions, 1);
      assert.lengthOf(tags(history, "LimitPaused"), 0);
      assert.lengthOf(tags(history, "LimitReached"), 1);
    }).pipe(
      Effect.provide(testLayer([claude.adapter, codex.adapter], { catalog: [codexEntry] })),
      Effect.scoped,
    );
  });

  it.live("doesn't loop between harnesses that are all out: it waits instead", () => {
    const claude = makeFakeAdapter("claude", { limit: () => ({ provider: "claude", message: "out" }) });
    const codex = makeFakeAdapter("codex", { limit: () => ({ provider: "codex", message: "out" }) });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* Store;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startThread("failover");
      yield* orchestrator.sendUserMessage(lead.id, "Build it");
      yield* waitFor((events) => tags(events, "LimitPaused")[0]);
      const history = yield* store.listEvents(lead.id);
      assert.lengthOf(tags(history, "LeadHandedOff"), 1, "moved once, not back");
      assert.lengthOf(claude.sessions, 1);
      assert.deepInclude(tags(history, "LimitPaused")[0]?.payload, { provider: "codex", reported: false });
    }).pipe(
      Effect.provide(testLayer([claude.adapter, codex.adapter], { catalog: [codexEntry] })),
      Effect.scoped,
    );
  });

  it.live("gives up after too many pauses in a row and says so", () => {
    const fake = makeFakeAdapter("claude", { limit: () => ({ provider: "claude", message: "out" }) });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* Store;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startThread("wait");
      yield* orchestrator.sendUserMessage(lead.id, "Build it");
      yield* waitFor((events) =>
        events.find(
          (event) =>
            event.payload._tag === "AgentError" && event.payload.message.startsWith("Still at its limit"),
        ),
      );
      const history = yield* store.listEvents(lead.id);
      assert.lengthOf(tags(history, "LimitPaused"), 2);
      assert.deepEqual(
        tags(history, "LimitPaused").map((event) =>
          event.payload._tag === "LimitPaused" ? event.payload.attempt : 0,
        ),
        [1, 2],
      );
    }).pipe(Effect.provide(testLayer([fake.adapter], { limitPause: { maxPauses: 2 } })), Effect.scoped);
  });

  it.live("leaves the turn failed when the thread's policy is off, whatever the setting says", () => {
    const fake = makeFakeAdapter("claude", { limit: () => ({ provider: "claude", message: "out" }) });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const store = yield* Store;
      const { waitFor } = yield* recordEvents;
      const { lead } = yield* startThread("off");
      yield* orchestrator.sendUserMessage(lead.id, "Build it");
      yield* waitFor((events) => tags(events, "TurnCompleted")[0]);
      yield* Effect.sleep("150 millis");
      const history = yield* store.listEvents(lead.id);
      assert.lengthOf(tags(history, "LimitReached"), 1);
      assert.lengthOf(tags(history, "LimitPaused"), 0);
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });

  it.live("follows the setting for all threads until a thread chooses, and changes with the choice", () => {
    const fake = makeFakeAdapter("claude", { limit: () => ({ provider: "claude", message: "out" }) });
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator;
      const settings = yield* UserSettings;
      const store = yield* Store;
      const { waitFor } = yield* recordEvents;
      yield* settings.update({ limits: { onLimit: "off" } });
      const { lead } = yield* startThread();
      yield* orchestrator.sendUserMessage(lead.id, "one");
      yield* waitFor((events) => tags(events, "TurnCompleted")[0]);
      yield* Effect.sleep("100 millis");
      assert.lengthOf(tags(yield* store.listEvents(lead.id), "LimitPaused"), 0);

      const chosen = yield* orchestrator.setThreadOnLimit(lead.threadId, "wait");
      assert.strictEqual(chosen.onLimit, "wait");
      yield* orchestrator.sendUserMessage(lead.id, "two");
      yield* waitFor((events) => tags(events, "LimitPaused")[0]);
      const cleared = yield* orchestrator.setThreadOnLimit(lead.threadId, undefined);
      assert.isUndefined(cleared.onLimit);
    }).pipe(Effect.provide(testLayer([fake.adapter])), Effect.scoped);
  });
});
