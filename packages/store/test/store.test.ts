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
  it.effect("pages search text without reading screenshot or tool payloads", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.createThread(thread);
        yield* store.createAgent(lead);
        const batch = Array.from({ length: 300 }, (_, n) => [
          event(n * 2),
          // Decoding this unrelated result would fail. Filtered reads must never decode it.
          {
            ...event(n * 2 + 1),
            payload: {
              _tag: "ToolCallCompleted",
              callId: `shot-${n}`,
              output: { data: "image" },
              isError: "invalid",
            },
          } as unknown as AgentEvent,
        ]).flat();
        yield* store.appendEvents(batch);
        const last = yield* store.messagePage(lead.id);
        const first = yield* store.messagePage(lead.id, last.before);
        assert.lengthOf(last.events, 256);
        assert.isTrue(last.more);
        assert.isFalse(first.more);
        assert.deepStrictEqual(
          [...first.events, ...last.events].map((e) => e.sequence),
          Array.from({ length: 300 }, (_, n) => n * 2),
        );
        assert.lengthOf(yield* store.listEvents(lead.id, { tags: ["MessageCompleted"] }), 300);
        const question: AgentEvent = {
          ...event(600),
          at: 0,
          payload: {
            _tag: "QuestionAsked",
            requestId: "pending-old",
            questions: [
              {
                question: "Keep this older request?",
                options: [],
                multiSelect: false,
                allowOther: true,
              },
            ],
          },
        };
        yield* store.appendEvents([question]);
        const recentState = yield* store.historyPage(thread.id, { state: true });
        assert.isFalse(recentState.events.some((each) => each.id === question.id));
        // Side panels read all their state, in bounded append pages, without decoding tool results.
        let page = yield* store.historyPage(thread.id, { after: 0, state: true });
        const state = [...page.events];
        assert.lengthOf(page.events, 256);
        while (page.more) {
          page = yield* store.historyPage(thread.id, { after: page.after, state: true });
          state.push(...page.events);
        }
        assert.lengthOf(state, 301);
        assert.isTrue(state.some((each) => each.payload._tag === "QuestionAsked"));
        assert.isFalse(state.some((each) => each.payload._tag === "ToolCallCompleted"));
        const request = {
          ...event(601),
          at: 0,
          payload: {
            _tag: "AgentError" as const,
            kind: "unknown" as const,
            retryable: false,
            message: "older state arriving late",
          },
        };
        yield* store.appendEvents([request]);
        const resumed = yield* store.historyPage(thread.id, { after: page.after, state: true });
        assert.deepStrictEqual(resumed.events, [request]);
        assert.isFalse(resumed.more);
      }),
    ),
  );
  it.effect(
    "pages tied timestamps and per-agent sequences without gaps, then catches late imports by append position",
    () =>
      withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.createThread(thread);
          yield* store.createAgent(lead);
          const child = { ...lead, id: "agt_child" as AgentId, parentId: lead.id };
          yield* store.createAgent(child);
          const initial = Array.from({ length: 12 }, (_, n) => ({
            ...event(Math.floor(n / 2)),
            id: `tie_${n.toString().padStart(2, "0")}` as EventId,
            agentId: n % 2 ? child.id : lead.id,
            at: 100,
          }));
          yield* store.appendEvents(initial);
          let page = yield* store.historyPage(thread.id, { limit: 3 });
          const watermark = page.after;
          const ids = page.events.map((e) => e.id);
          while (page.more) {
            page = yield* store.historyPage(thread.id, { before: page.before!, limit: 3 });
            ids.unshift(...page.events.map((e) => e.id));
          }
          assert.deepStrictEqual(
            ids,
            initial.map((e) => e.id),
          );
          const imported = { ...event(6), at: 0 };
          yield* store.appendEvents([imported, event(7), event(8)]);
          const resumed = yield* store.historyPage(thread.id, { after: watermark, limit: 2 });
          assert.deepStrictEqual(
            resumed.events.map((e) => e.id),
            [imported.id, event(7).id],
          );
          assert.isTrue(resumed.more);
          const end = yield* store.historyPage(thread.id, { after: resumed.after, limit: 2 });
          assert.deepStrictEqual(
            end.events.map((e) => e.id),
            [event(8).id],
          );
          assert.isFalse(end.more);
        }),
      ),
  );

  it.effect("fills only the requested compact page and persists its progress across reopen", () => {
    const filename = join(mkdtempSync(join(tmpdir(), "cerium-page-")), "events.db");
    return Effect.gen(function* () {
      const store = yield* Store;
      yield* store.createThread(thread);
      yield* store.createAgent(lead);
      yield* store.appendEvents(Array.from({ length: 40 }, (_, n) => event(n)));
      const db = new DatabaseSync(filename);
      db.exec("DELETE FROM ui_events");
      const page = yield* store.historyPage(thread.id, { limit: 5 });
      assert.lengthOf(page.events, 5);
      assert.deepStrictEqual(db.prepare("SELECT count(*) AS n FROM ui_events").get()?.n, 5);
      yield* store.historyPage(thread.id, { limit: 5 });
      assert.deepStrictEqual(db.prepare("SELECT count(*) AS n FROM ui_events").get()?.n, 5);
      yield* store.historyPage(thread.id, { before: page.before!, limit: 5 });
      assert.deepStrictEqual(db.prepare("SELECT count(*) AS n FROM ui_events").get()?.n, 10);
      db.close();
    }).pipe(Effect.provide(Store.layer({ filename, migrationsFolder })));
  });
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
        assert.deepStrictEqual(yield* store.getThread(thread.id), Option.none());
        assert.deepStrictEqual(yield* store.listAgents(thread.id), []);
        assert.deepStrictEqual(yield* store.listThreadEvents(thread.id), []);
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
          assert.deepStrictEqual(ids(yield* store.listSyncedEventsAfter(thread.id, undefined, 10)), [
            "evt_3",
            "evt_1",
            "evt_4",
          ]);
          assert.strictEqual(yield* store.syncedEventCursor(thread.id, 0), undefined);
          const first = yield* store.syncedEventCursor(thread.id, 1);
          assert.strictEqual(first, "evt_3");
          assert.deepStrictEqual(ids(yield* store.listSyncedEventsAfter(thread.id, first, 1)), ["evt_1"]);
          const second = yield* store.syncedEventCursor(thread.id, 2);
          assert.strictEqual(second, "evt_1");
          assert.deepStrictEqual(ids(yield* store.listSyncedEventsAfter(thread.id, second, 10)), ["evt_4"]);
          const end = yield* store.syncedEventCursor(thread.id, 3);
          assert.deepStrictEqual(ids(yield* store.listSyncedEventsAfter(thread.id, end, 10)), []);
          yield* store.appendEvents([event(5)]);
          assert.deepStrictEqual(ids(yield* store.listSyncedEventsAfter(thread.id, end, 10)), ["evt_5"]);
          assert.deepStrictEqual(
            ids(yield* store.listSyncedEventsAfter(thread.id, "deleted-anchor", 10)),
            [],
          );
          assert(Exit.isFailure(yield* Effect.exit(store.syncedEventCursor(thread.id, 20))));
        }),
      ),
  );

  it.effect("keeps sync anchors across rowid gaps and VACUUM, without a page sort", () => {
    const filename = join(mkdtempSync(join(tmpdir(), "cerium-sync-")), "events.db");
    return Effect.gen(function* () {
      const store = yield* Store;
      const other = { ...thread, id: "thr_removed" as ThreadId };
      const otherLead = { ...lead, id: "agt_removed" as AgentId, threadId: other.id };
      yield* store.createThread(other);
      yield* store.createThread(thread);
      yield* store.createAgent(otherLead);
      yield* store.createAgent(lead);
      yield* store.appendEvents([
        { ...event(0), id: "evt_removed" as EventId, threadId: other.id, agentId: otherLead.id },
        event(1),
        event(2),
        event(3),
      ]);
      const anchor = yield* store.syncedEventCursor(thread.id, 1);
      yield* store.deleteThread(other.id);
      const db = new DatabaseSync(filename);
      db.exec("VACUUM");
      const plan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM events WHERE thread_id=? AND tag NOT IN ('MessageDelta','ReasoningDelta') AND rowid>(SELECT rowid FROM events WHERE id=?) ORDER BY rowid LIMIT 200",
        )
        .all(thread.id, anchor!);
      assert.isFalse(plan.some((row) => String(row.detail).includes("TEMP B-TREE")));
      assert.isTrue(
        plan.some((row) => String(row.detail).includes("events_thread (thread_id=? AND rowid>?)")),
      );
      db.close();
      assert.deepStrictEqual(
        (yield* store.listSyncedEventsAfter(thread.id, anchor, 200)).map((row) => row.id),
        ["evt_2", "evt_3"],
      );
    }).pipe(Effect.provide(Store.layer({ filename, migrationsFolder })));
  });

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
          { path: "C:/a", addedAt: 1, usedAt: 3, setup: null, run: null, teardown: null, actions: null },
          { path: "C:/b", addedAt: 2, usedAt: 2, setup: null, run: null, teardown: null, actions: null },
        ]);

        yield* store.removeProject("C:/a");
        assert.deepStrictEqual(
          (yield* store.listProjects).map((project) => project.path),
          ["C:/b"],
        );
      }),
    ),
  );

  it.effect("keeps a project's saved named commands apart from its setup and run", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const actions = [{ name: "Test", command: "bun test" }];
        yield* store.writeProjectScripts("C:/a", { setup: "bun install", run: null, actions });
        // Leaving `actions` out leaves what was saved; null defers to the project's file again.
        yield* store.writeProjectScripts("C:/a", { setup: "pnpm install", run: "bun run dev" });
        assert.deepStrictEqual(
          (yield* store.listProjects).map(({ setup, run, actions: saved }) => ({ setup, run, saved })),
          [{ setup: "pnpm install", run: "bun run dev", saved: actions }],
        );
        yield* store.writeProjectScripts("C:/a", { setup: null, run: null, actions: null });
        assert.deepStrictEqual(
          (yield* store.listProjects).map((project) => project.actions),
          [null],
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
});
