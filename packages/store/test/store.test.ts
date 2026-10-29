import {
  REMOVED_IMAGE,
  type AgentEvent,
  type EventPayload,
  type AgentId,
  type AgentInfo,
  type EventId,
  type ThreadId,
  type ThreadInfo,
} from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { Store } from "../src/index.ts";

const migrationsFolder = join(import.meta.dirname, "..", "migrations");
const withStore = <A, E>(effect: Effect.Effect<A, E, Store>) =>
  effect.pipe(Effect.provide(Store.layer({ filename: ":memory:", migrationsFolder })));

const thread: ThreadInfo = {
  id: "thr_1" as ThreadId,
  title: "Fix flaky test",
  mode: "work",
  cwd: "C:/repo",
  createdAt: 1,
  updatedAt: 1,
};

const lead: AgentInfo = {
  id: "agt_lead" as AgentId,
  threadId: thread.id,
  role: "lead",
  provider: "claude",
  model: "claude-opus-5-5",
  effort: "high",
  access: "ask",
  state: "idle",
  createdAt: 2,
  updatedAt: 2,
};

const event = (sequence: number, text = `message ${sequence}`): AgentEvent => ({
  id: `evt_${sequence}` as EventId,
  threadId: thread.id,
  agentId: lead.id,
  sequence,
  at: 10 + sequence,
  payload: { _tag: "MessageCompleted", messageId: `m${sequence}`, text },
});

describe("Store", () => {
  it.effect("backfills compact history for old events once and keeps it idempotent", () => {
    const filename = join(mkdtempSync(join(tmpdir(), "cerium-compact-")), "events.db");
    return Effect.gen(function* () {
      const store = yield* Store;
      yield* store.createThread(thread);
      yield* store.createAgent(lead);
      yield* store.appendEvents([event(0)]);
      const db = new DatabaseSync(filename);
      db.exec("DELETE FROM ui_events");
      db.close();
      assert.deepStrictEqual(yield* store.listThreadEvents(thread.id, { withoutImages: true }), [event(0)]);
      assert.deepStrictEqual(yield* store.listThreadEvents(thread.id, { withoutImages: true }), [event(0)]);
    }).pipe(Effect.provide(Store.layer({ filename, migrationsFolder })));
  });
  it.effect("keeps image-free UI history while preserving the original tool image, and deletes both", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createThread(thread);
        yield* store.createAgent(lead);
        const image = { type: "image", mimeType: "image/png", data: "a".repeat(20_000) };
        const original: AgentEvent = {
          ...event(0),
          payload: {
            _tag: "ToolCallCompleted",
            callId: "shot",
            output: { content: [image] },
            isError: false,
          },
        };
        yield* store.appendEvents([original]);
        const compact = yield* store.listThreadEvents(thread.id, { withoutImages: true });
        assert.isBelow(JSON.stringify(compact).length, 1000);
        assert.deepStrictEqual(yield* store.listThreadEvents(thread.id), [original]);
        assert.deepStrictEqual(
          Option.getOrThrow(yield* store.findToolCompletion(thread.id, "shot")),
          original,
        );
        yield* store.deleteThread(thread.id);
        assert.deepStrictEqual(yield* store.listThreadEvents(thread.id, { withoutImages: true }), []);
      }),
    ),
  );
  it.effect("slims threads gone quiet, keeping their text and slimming again after new events", () => {
    const filename = join(mkdtempSync(join(tmpdir(), "cerium-slim-")), "events.db");
    const shot = (sequence: number, callId: string): AgentEvent => ({
      ...event(sequence),
      payload: {
        _tag: "ToolCallCompleted",
        callId,
        output: {
          content: [
            { type: "text", text: "took a screenshot" },
            { type: "image", mimeType: "image/png", data: "a".repeat(20_000) },
          ],
        },
        isError: false,
      },
      raw: { harness: "b".repeat(5_000) },
    });
    const removed = (callId: string): EventPayload => ({
      _tag: "ToolCallCompleted",
      callId,
      output: {
        content: [
          { type: "text", text: "took a screenshot" },
          { type: "image", mimeType: "image/png", data: REMOVED_IMAGE },
        ],
      },
      isError: false,
    });
    const raws = () => {
      const db = new DatabaseSync(filename);
      const rows = db.prepare("SELECT count(*) AS n FROM events WHERE raw IS NOT NULL").get();
      db.close();
      return rows?.["n"];
    };
    return Effect.gen(function* () {
      const store = yield* Store;
      yield* store.createThread(thread);
      yield* store.createAgent(lead);
      yield* store.appendEvents([{ ...event(0), raw: { harness: "c" } }, shot(1, "one")]);
      assert.strictEqual(raws(), 0, "harness payloads aren't kept");
      // As an older version kept them.
      const legacy = new DatabaseSync(filename);
      legacy.exec(`UPDATE events SET raw = '{"harness":"old"}'`);
      legacy.close();

      assert.strictEqual(yield* store.slimThreads(11), 0, "not quiet since then");
      assert.strictEqual(yield* store.slimThreads(100), 1);
      assert.strictEqual(raws(), 0);
      const [message, tool] = yield* store.listThreadEvents(thread.id);
      assert.deepStrictEqual(message, event(0));
      assert.deepStrictEqual(tool?.payload, removed("one"));
      const [, compact] = yield* store.listThreadEvents(thread.id, { withoutImages: true });
      assert.deepStrictEqual(compact?.payload, removed("one"));
      assert.strictEqual(yield* store.slimThreads(100), 0, "already slim");

      yield* store.appendEvents([shot(2, "two")]);
      assert.strictEqual(yield* store.slimThreads(100), 1);
      assert.deepStrictEqual(
        Option.getOrThrow(yield* store.findToolCompletion(thread.id, "two")).payload,
        removed("two"),
      );
      yield* store.reclaimSpace({ rewrite: true });
    }).pipe(Effect.provide(Store.layer({ filename, migrationsFolder })));
  });
  it.effect("drops the harness payloads an older version kept, from every thread", () => {
    const filename = join(mkdtempSync(join(tmpdir(), "cerium-raw-")), "events.db");
    const sql = (statement: string) => {
      const db = new DatabaseSync(filename);
      const row = db.prepare(statement).get();
      db.close();
      return row === undefined ? undefined : Object.values(row)[0];
    };
    return Effect.gen(function* () {
      const store = yield* Store;
      yield* store.createThread(thread);
      yield* store.createAgent(lead);
      // More than one step's worth.
      yield* store.appendEvents(Array.from({ length: 600 }, (_, index) => event(index)));
      const legacy = new DatabaseSync(filename);
      legacy.exec(`UPDATE events SET raw = '{"harness":"old"}' WHERE sequence % 2 = 0`);
      legacy.close();
      assert.strictEqual(yield* store.dropHarnessPayloads, 300);
      assert.strictEqual(sql("SELECT count(*) FROM events WHERE raw IS NOT NULL"), 0);
      assert.strictEqual(yield* store.dropHarnessPayloads, 0);
      assert.lengthOf(yield* store.listThreadEvents(thread.id), 600);
    }).pipe(Effect.provide(Store.layer({ filename, migrationsFolder })));
  });
  it.effect("hands freed space back to the disk, rewriting the file once and in steps after", () => {
    const filename = join(mkdtempSync(join(tmpdir(), "cerium-reclaim-")), "events.db");
    const pragma = (name: string) => {
      const db = new DatabaseSync(filename);
      const row = db.prepare(`PRAGMA ${name}`).get();
      db.close();
      return Object.values(row ?? {})[0];
    };
    const fill = (from: number) =>
      Array.from({ length: 40 }, (_, index): AgentEvent => ({
        ...event(from + index),
        payload: {
          _tag: "ToolCallCompleted",
          callId: `call-${from + index}`,
          output: { content: [{ type: "image", mimeType: "image/png", data: "r".repeat(1_000_000) }] },
          isError: false,
        },
      }));
    return Effect.gen(function* () {
      const store = yield* Store;
      yield* store.createThread(thread);
      yield* store.createAgent(lead);
      yield* store.appendEvents(fill(0));
      yield* store.slimThreads(1_000);
      assert.isAbove(Number(pragma("freelist_count")), 4096);
      // Not while the app is busy: the rewrite stays due.
      assert.isTrue(yield* store.reclaimSpace({ rewrite: false }));
      assert.strictEqual(pragma("auto_vacuum"), 0);
      assert.isFalse(yield* store.reclaimSpace({ rewrite: true }));
      assert.strictEqual(pragma("auto_vacuum"), 2);
      assert.strictEqual(pragma("freelist_count"), 0);
      // The store's own connection carries on after the rewrite.
      assert.lengthOf(yield* store.listThreadEvents(thread.id), 40);

      yield* store.appendEvents(fill(100));
      yield* store.slimThreads(1_000);
      assert.isAbove(Number(pragma("freelist_count")), 0);
      assert.isFalse(yield* store.reclaimSpace({ rewrite: false }));
      assert.strictEqual(pragma("freelist_count"), 0);
    }).pipe(Effect.provide(Store.layer({ filename, migrationsFolder })));
  });
  it.effect("round-trips threads, keeping absent optional fields absent", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const chat: ThreadInfo = {
          id: "thr_chat" as ThreadId,
          title: "Q",
          mode: "chat",
          createdAt: 3,
          updatedAt: 3,
        };
        const isolated: ThreadInfo = {
          ...thread,
          id: "thr_isolated" as ThreadId,
          cwd: "/home/me/.cerium/worktrees/proj/fix",
          worktree: {
            project: "/home/me/proj",
            root: "/home/me/.cerium/worktrees/proj/fix",
            branch: "cerium/fix",
            base: "main",
          },
          createdAt: 4,
        };
        yield* store.createThread(thread);
        yield* store.createThread(chat);
        yield* store.createThread(isolated);
        assert.deepStrictEqual(yield* store.getThread(thread.id), Option.some(thread));
        assert.deepStrictEqual(yield* store.getThread(isolated.id), Option.some(isolated));
        assert.deepStrictEqual(yield* store.listThreads, [thread, chat, isolated]);
        assert.isTrue(Option.isNone(yield* store.getThread("missing" as ThreadId)));
      }),
    ),
  );

  it.effect("renames, archives and restores threads", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createThread(thread);
        yield* store.updateThread(thread.id, { title: "Renamed", archivedAt: 9 });
        assert.deepStrictEqual(
          yield* store.getThread(thread.id),
          Option.some({ ...thread, title: "Renamed", archivedAt: 9 }),
        );
        yield* store.updateThread(thread.id, { archivedAt: null });
        assert.deepStrictEqual(
          yield* store.getThread(thread.id),
          Option.some({ ...thread, title: "Renamed" }),
        );
      }),
    ),
  );

  it.effect("deletes a thread with its agents and events", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createThread(thread);
        yield* store.createAgent(lead);
        yield* store.appendEvents([event(0)]);
        yield* store.deleteThread(thread.id);
        assert.deepStrictEqual(yield* store.getThread(thread.id), Option.none());
        assert.deepStrictEqual(yield* store.listAgents(thread.id), []);
        assert.deepStrictEqual(yield* store.listThreadEvents(thread.id), []);
      }),
    ),
  );

  it.effect("lists every thread and agent as they stand after each write", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const states = Effect.map(store.listAllAgents, (all) => all.map((agent) => agent.state));
        assert.deepStrictEqual(yield* store.listThreads, []);
        assert.deepStrictEqual(yield* store.listAllAgents, []);
        yield* store.createThread(thread);
        assert.deepStrictEqual(yield* store.listThreads, [thread]);
        yield* store.updateThread(thread.id, { title: "Renamed" });
        assert.deepStrictEqual(yield* store.listThreads, [{ ...thread, title: "Renamed" }]);
        yield* store.createAgent({ ...lead, state: "running" });
        assert.deepStrictEqual(yield* states, ["running"]);
        yield* store.updateAgent(lead.id, { state: "idle", updatedAt: 5 });
        assert.deepStrictEqual(yield* states, ["idle"]);
        yield* store.stopLiveAgents;
        assert.deepStrictEqual(yield* states, ["stopped"]);
        yield* store.deleteThread(thread.id);
        assert.deepStrictEqual(yield* store.listThreads, []);
        assert.deepStrictEqual(yield* store.listAllAgents, []);
      }),
    ),
  );

  it.effect("finds threads by the words in their messages, the user's and the agents'", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const chat: ThreadInfo = {
          id: "thr_chat" as ThreadId,
          title: "Q",
          mode: "chat",
          createdAt: 3,
          updatedAt: 3,
        };
        const chatLead: AgentInfo = { ...lead, id: "agt_chat" as AgentId, threadId: chat.id };
        yield* store.createThread(thread);
        yield* store.createThread(chat);
        yield* store.createAgent(lead);
        yield* store.createAgent(chatLead);
        yield* store.appendEvents([
          event(0, "The flaky checkout test fails on Windows"),
          {
            ...event(1),
            payload: {
              _tag: "TurnInput",
              items: [{ _tag: "FromUser", text: "Please rerun the checkout suite" }],
            },
          },
          // A child agent's report back is not the user's message and is not searched.
          {
            ...event(2),
            payload: {
              _tag: "TurnInput",
              items: [
                {
                  _tag: "ChildFinishedTurn",
                  agentId: "agt_child" as AgentId,
                  role: "reviewer",
                  text: "checkout looks fine",
                },
              ],
            },
          },
          { ...event(3, "Checkout is also slow"), threadId: chat.id, agentId: chatLead.id },
        ]);

        const work = yield* store.searchMessages("checkout", { mode: "work", limit: 10 });
        assert.deepStrictEqual(
          work.map((match) => match.threadId),
          [thread.id],
        );
        assert.isTrue(
          work[0]?.passage.some((piece) => piece.match && piece.text.toLowerCase() === "checkout"),
        );
        // Words match as prefixes and all of them must be there, so results narrow as the user types.
        assert.strictEqual((yield* store.searchMessages("check", { mode: "work", limit: 10 })).length, 1);
        assert.strictEqual(
          (yield* store.searchMessages("checkout win", { mode: "work", limit: 10 })).length,
          1,
        );
        assert.strictEqual(
          (yield* store.searchMessages("checkout linux", { mode: "work", limit: 10 })).length,
          0,
        );
        // Each mode searches its own threads, and query syntax typed as text is only text.
        assert.deepStrictEqual(
          (yield* store.searchMessages("checkout", { mode: "chat", limit: 10 })).map(
            (match) => match.threadId,
          ),
          [chat.id],
        );
        assert.deepStrictEqual(yield* store.searchMessages('"AND* NOT (', { mode: "work", limit: 10 }), []);
        assert.deepStrictEqual(yield* store.searchMessages("  ", { mode: "work", limit: 10 }), []);
        assert.strictEqual(
          (yield* store.searchMessages("checkout\u0000win", { mode: "work", limit: 10 })).length,
          1,
        );

        yield* store.deleteThread(thread.id);
        assert.deepStrictEqual(yield* store.searchMessages("checkout", { mode: "work", limit: 10 }), []);
      }),
    ),
  );

  it.effect("creates, updates and lists agents", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const child: AgentInfo = {
          ...lead,
          id: "agt_child" as AgentId,
          parentId: lead.id,
          role: "reviewer",
          access: "readOnly",
          createdAt: 5,
          updatedAt: 5,
        };
        yield* store.createThread(thread);
        yield* store.createAgent(lead);
        yield* store.createAgent(child);
        yield* store.updateAgent(lead.id, { state: "running", providerSessionId: "s-1", updatedAt: 9 });

        const agents = yield* store.listAgents(thread.id);
        assert.deepStrictEqual(
          agents.map((agent) => [agent.id, agent.state]),
          [
            [lead.id, "running"],
            [child.id, "idle"],
          ],
        );
        assert.deepStrictEqual(yield* store.getAgent(child.id), Option.some(child));
        assert.strictEqual(Option.getOrThrow(yield* store.getAgent(lead.id)).providerSessionId, "s-1");

        // Switching to a model without an effort setting clears the effort.
        yield* store.updateAgent(lead.id, { model: "claude-sonnet-5-5", effort: "low", updatedAt: 10 });
        assert.strictEqual(Option.getOrThrow(yield* store.getAgent(lead.id)).effort, "low");
        yield* store.updateAgent(lead.id, { model: "claude-haiku-4-5", effort: null, updatedAt: 11 });
        const switched = Option.getOrThrow(yield* store.getAgent(lead.id));
        assert.strictEqual(switched.model, "claude-haiku-4-5");
        assert.isFalse("effort" in switched);

        const other: AgentInfo = { ...lead, id: "agt_other" as AgentId, threadId: "thr_2" as ThreadId };
        yield* store.createThread({ ...thread, id: other.threadId });
        yield* store.createAgent(other);
        assert.deepStrictEqual(
          (yield* store.listAllAgents).map((agent) => agent.id),
          [lead.id, other.id, child.id],
        );
      }),
    ),
  );

  it.effect("appends events and reads them back in sequence order", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createThread(thread);
        yield* store.createAgent(lead);
        assert.isTrue(Option.isNone(yield* store.lastSequence(lead.id)));

        yield* store.appendEvents([event(2), event(0), event(1)]);
        yield* store.appendEvents([]);

        const all = yield* store.listEvents(lead.id);
        assert.deepStrictEqual(
          all.map((stored) => stored.sequence),
          [0, 1, 2],
        );
        assert.deepStrictEqual(all[0], event(0));
        assert.deepStrictEqual(
          (yield* store.listEvents(lead.id, { afterSequence: 0 })).map((stored) => stored.sequence),
          [1, 2],
        );
        assert.deepStrictEqual(yield* store.lastSequence(lead.id), Option.some(2));
      }),
    ),
  );

  it.effect("keeps a provider's raw message but leaves it out of what it lists", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createThread(thread);
        yield* store.createAgent(lead);
        yield* store.appendEvents([{ ...event(0), raw: { type: "assistant", big: "x".repeat(1000) } }]);
        assert.deepStrictEqual(yield* store.listEvents(lead.id), [event(0)]);
        assert.deepStrictEqual(yield* store.listThreadEvents(thread.id), [event(0)]);
      }),
    ),
  );

  it.effect("lists a thread's events across agents and stops agents left live by a previous run", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const child: AgentInfo = { ...lead, id: "agt_child" as AgentId, parentId: lead.id, role: "scout" };
        yield* store.createThread(thread);
        yield* store.createAgent(lead);
        yield* store.createAgent(child);
        yield* store.appendEvents([
          event(0),
          { ...event(0), id: "evt_child" as EventId, agentId: child.id, at: 11 },
        ]);
        yield* store.appendEvents([event(1)]);

        const history = yield* store.listThreadEvents(thread.id);
        assert.deepStrictEqual(
          history.map((stored) => stored.id),
          ["evt_0", "evt_child", "evt_1"],
        );

        yield* store.updateAgent(child.id, { state: "failed", updatedAt: 20 });
        yield* store.stopLiveAgents;
        const stopped = yield* store.listAgents(thread.id);
        assert.deepStrictEqual(
          stopped.map((agent) => agent.state),
          ["stopped", "failed"],
        );
        assert.strictEqual(stopped[0]?.updatedAt, lead.updatedAt, "stopping isn't activity");
      }),
    ),
  );

  it.effect("lists one kind of event across threads", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const other: ThreadInfo = { ...thread, id: "thr_2" as ThreadId };
        const otherLead: AgentInfo = { ...lead, id: "agt_other" as AgentId, threadId: other.id };
        const input = (id: string, agent: AgentInfo, at: number): AgentEvent => ({
          id: id as EventId,
          threadId: agent.threadId,
          agentId: agent.id,
          sequence: at,
          at,
          payload: { _tag: "TurnInput", items: [{ _tag: "FromUser", text: id }] },
        });
        yield* store.createThread(thread);
        yield* store.createThread(other);
        yield* store.createAgent(lead);
        yield* store.createAgent(otherLead);
        yield* store.appendEvents([input("evt_late", lead, 30), event(1), input("evt_early", otherLead, 20)]);

        assert.deepStrictEqual(
          (yield* store.listEventsByTag("TurnInput")).map((stored) => stored.id),
          ["evt_early", "evt_late"],
        );
      }),
    ),
  );

  it.effect("finds the given agents' completed messages holding some text, newest first", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const other: ThreadInfo = { ...thread, id: "thr_2" as ThreadId };
        const otherLead: AgentInfo = { ...lead, id: "agt_other" as AgentId, threadId: other.id };
        const message = (id: string, agent: AgentInfo, at: number, text: string): AgentEvent => ({
          id: id as EventId,
          threadId: agent.threadId,
          agentId: agent.id,
          sequence: at,
          at,
          payload: { _tag: "MessageCompleted", messageId: id, text },
        });
        yield* store.createThread(thread);
        yield* store.createThread(other);
        yield* store.createAgent(lead);
        yield* store.createAgent(otherLead);
        yield* store.appendEvents([
          message("evt_old", lead, 10, "```artifact\n<p>old</p>\n```"),
          message("evt_plain", lead, 20, "No visuals here."),
          message("evt_new", lead, 30, "```artifact\n<p>new</p>\n```"),
          message("evt_elsewhere", otherLead, 40, "```artifact\n<p>other</p>\n```"),
        ]);

        const found = yield* store.listMessagesContaining([lead.id], "```artifact", 10);
        assert.deepStrictEqual(
          found.map((stored) => stored.id),
          ["evt_new", "evt_old"],
        );
        assert.deepStrictEqual(
          (yield* store.listMessagesContaining([lead.id, otherLead.id], "```artifact", 1)).map(
            (stored) => stored.id,
          ),
          ["evt_elsewhere"],
        );
        assert.deepStrictEqual(yield* store.listMessagesContaining([], "```artifact", 10), []);
      }),
    ),
  );

  it.effect(
    "counts and pages the events the cloud copy keeps, in stored order and without streamed text",
    () =>
      withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.createThread(thread);
          yield* store.createAgent(lead);
          const delta: AgentEvent = {
            ...event(2),
            id: "evt_delta" as EventId,
            payload: { _tag: "MessageDelta", messageId: "m2", text: "partial" },
          };
          // Stored out of time order: the copy follows the order they were stored in.
          yield* store.appendEvents([event(3), delta, event(1)]);
          yield* store.appendEvents([event(4)]);
          assert.deepStrictEqual(yield* store.countSyncedEvents, new Map([[thread.id, 3]]));
          const ids = (events: ReadonlyArray<AgentEvent>) => events.map((each) => each.id);
          assert.deepStrictEqual(ids(yield* store.listSyncedEvents(thread.id, 0, 10)), [
            "evt_3",
            "evt_1",
            "evt_4",
          ]);
          assert.deepStrictEqual(ids(yield* store.listSyncedEvents(thread.id, 1, 1)), ["evt_1"]);
          assert.deepStrictEqual(ids(yield* store.listSyncedEvents(thread.id, 3, 10)), []);
        }),
      ),
  );

  it.effect("finds how a tool call in a thread ended by its id, through the index", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const other: ThreadInfo = { ...thread, id: "thr_other" as ThreadId };
        const otherLead: AgentInfo = { ...lead, id: "agt_other" as AgentId, threadId: other.id };
        yield* store.createThread(thread);
        yield* store.createThread(other);
        yield* store.createAgent(lead);
        yield* store.createAgent(otherLead);
        const tool = (id: string, threadEvent: AgentEvent, payload: AgentEvent["payload"]): AgentEvent => ({
          ...threadEvent,
          id: id as EventId,
          payload,
        });
        const done = (callId: string) =>
          ({ _tag: "ToolCallCompleted", callId, output: `out ${callId}`, isError: false }) as const;
        yield* store.appendEvents([
          tool("evt_started", event(1), {
            _tag: "ToolCallStarted",
            callId: "call_1",
            toolName: "Bash",
            input: {},
          }),
          tool("evt_1", event(2), done("call_1")),
          tool("evt_2", event(3), done("call_2")),
        ]);
        yield* store.appendEvents([
          tool("evt_elsewhere", { ...event(1), threadId: other.id, agentId: otherLead.id }, done("call_3")),
        ]);
        const found = (threadId: ThreadId, callId: string) =>
          store.findToolCompletion(threadId, callId).pipe(Effect.map(Option.map((stored) => stored.id)));
        assert.deepStrictEqual(yield* found(thread.id, "call_1"), Option.some("evt_1"));
        assert.deepStrictEqual(yield* found(thread.id, "call_2"), Option.some("evt_2"));
        assert.isTrue(Option.isNone(yield* found(thread.id, "call_3")));
        assert.deepStrictEqual(yield* found(other.id, "call_3"), Option.some("evt_elsewhere"));
      }),
    ),
  );

  it.effect("stores a batch atomically", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createThread(thread);
        yield* store.createAgent(lead);
        yield* store.appendEvents([event(0)]);

        const duplicate = yield* Effect.exit(
          store.appendEvents([event(1), { ...event(0), id: "evt_dup" as EventId }]),
        );
        assert.isTrue(Exit.isFailure(duplicate));
        assert.deepStrictEqual(
          (yield* store.listEvents(lead.id)).map((stored) => stored.sequence),
          [0],
        );
      }),
    ),
  );

  it.effect("stores settings as JSON values, replacing earlier ones", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        assert.deepStrictEqual(yield* store.readSettings, {});

        yield* store.writeSettings({ includeUserMcpServers: false, nested: { a: [1, 2] } });
        yield* store.writeSettings({ includeUserMcpServers: true });
        yield* store.writeSettings({});

        assert.deepStrictEqual(yield* store.readSettings, {
          includeUserMcpServers: true,
          nested: { a: [1, 2] },
        });
      }),
    ),
  );

  it.effect("stores a project's commands one at a time, leaving the others as they were", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const scripts = () =>
          store.listProjects.pipe(
            Effect.map(([project]) => ({
              setup: project?.setup,
              run: project?.run,
              teardown: project?.teardown,
            })),
          );
        yield* store.writeProjectScripts("C:/a", { setup: "bun install", run: "" });
        assert.deepStrictEqual(yield* scripts(), { setup: "bun install", run: "", teardown: null });
        yield* store.writeProjectScripts("C:/a", { teardown: "docker compose down" });
        assert.deepStrictEqual(yield* scripts(), {
          setup: "bun install",
          run: "",
          teardown: "docker compose down",
        });
        // `null` defers again to the project's own file; nothing at all changes nothing.
        yield* store.writeProjectScripts("C:/a", { setup: null });
        yield* store.writeProjectScripts("C:/a", {});
        assert.deepStrictEqual(yield* scripts(), { setup: null, run: "", teardown: "docker compose down" });
      }),
    ),
  );

  it.effect("keeps a thread's ports for its life, and never gives two threads the same block", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const thread = (id: string) => ({
          id: id as ThreadId,
          title: id,
          mode: "work" as const,
          cwd: "/w",
          createdAt: 1,
          updatedAt: 1,
        });
        yield* store.createThread(thread("thr_a"));
        yield* store.createThread(thread("thr_b"));
        assert.isNull(yield* store.threadPort("thr_a" as ThreadId));
        assert.strictEqual(yield* store.giveThreadPort("thr_a" as ThreadId, 20_000), 20_000);
        // A thread that has a block keeps it.
        assert.strictEqual(yield* store.giveThreadPort("thr_a" as ThreadId, 20_010), 20_000);
        assert.strictEqual(yield* store.giveThreadPort("thr_b" as ThreadId, 20_010), 20_010);
        assert.deepStrictEqual(
          (yield* store.threadPorts).toSorted((a, b) => a - b),
          [20_000, 20_010],
        );
        yield* store.deleteThread("thr_a" as ThreadId);
        assert.deepStrictEqual(yield* store.threadPorts, [20_010]);
      }),
    ),
  );

  it.effect("keeps project folders most recently used first, remembering when each was added", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.saveProject("C:/a", 1);
        yield* store.saveProject("C:/b", 2);
        yield* store.saveProject("C:/a", 3);
        assert.deepStrictEqual(yield* store.listProjects, [
          { path: "C:/a", addedAt: 1, usedAt: 3, setup: null, run: null, teardown: null },
          { path: "C:/b", addedAt: 2, usedAt: 2, setup: null, run: null, teardown: null },
        ]);

        yield* store.removeProject("C:/a");
        assert.deepStrictEqual(
          (yield* store.listProjects).map((project) => project.path),
          ["C:/b"],
        );
      }),
    ),
  );

  it.effect("lists the usage reported in a span with the events that name each turn's model", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createThread(thread);
        yield* store.createAgent(lead);
        const at = (sequence: number, time: number, payload: AgentEvent["payload"]): AgentEvent => ({
          ...event(sequence),
          at: time,
          payload,
        });
        yield* store.appendEvents([
          at(0, 1, { _tag: "SessionStarted", provider: "claude", providerSessionId: "s", model: "m1" }),
          at(1, 2, { _tag: "TurnInput", items: [{ _tag: "FromUser", text: "go" }] }),
          at(2, 5, { _tag: "UsageReported", inputTokens: 1, outputTokens: 2 }),
          at(3, 15, { _tag: "ModelChanged", model: "m2" }),
          at(4, 20, {
            _tag: "UsageReported",
            inputTokens: 3,
            outputTokens: 4,
            cachedInputTokens: 5,
            costUsd: 0.5,
          }),
          at(5, 30, { _tag: "UsageReported", inputTokens: 9, outputTokens: 9 }),
          at(6, 31, { _tag: "MessageCompleted", messageId: "m", text: "hi" }),
        ]);
        const rest = { agentId: lead.id, threadId: thread.id };
        assert.deepStrictEqual(yield* store.listSpendEvents(10, 30), [
          { ...rest, at: 1, tag: "SessionStarted", model: "m1" },
          { ...rest, at: 2, tag: "TurnInput" },
          { ...rest, at: 15, tag: "ModelChanged", model: "m2" },
          {
            ...rest,
            at: 20,
            tag: "UsageReported",
            inputTokens: 3,
            outputTokens: 4,
            cachedInputTokens: 5,
            costUsd: 0.5,
          },
        ]);
      }),
    ),
  );

  it.effect("enforces foreign keys", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const orphan = yield* Effect.exit(store.createAgent(lead));
        assert.isTrue(Exit.isFailure(orphan));
      }),
    ),
  );
});
