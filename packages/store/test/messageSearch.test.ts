import type { AgentEvent, AgentId, AgentInfo, EventId, ThreadId, ThreadInfo } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Store } from "../src/index.ts";

const migrationsFolder = join(import.meta.dirname, "..", "migrations");
/** The migration that moved the search index's text into a table indexed by thread. */
const OWNER = "20261030040000_message_search_owner";

const threadOf = (n: number): ThreadInfo => ({
  id: `thr_${n}` as ThreadId,
  title: `Thread ${n}`,
  mode: "work",
  cwd: "C:/repo",
  createdAt: n,
  updatedAt: n,
});
const leadOf = (n: number): AgentInfo => ({
  id: `agt_${n}` as AgentId,
  threadId: threadOf(n).id,
  role: "lead",
  provider: "claude",
  model: "claude-opus-5-5",
  effort: "high",
  access: "ask",
  state: "idle",
  createdAt: n,
  updatedAt: n,
});
const said = (n: number, sequence: number, text: string): AgentEvent => ({
  id: `evt_${n}_${sequence}` as EventId,
  threadId: threadOf(n).id,
  agentId: leadOf(n).id,
  sequence,
  at: sequence,
  payload: { _tag: "MessageCompleted", messageId: `m${n}_${sequence}`, text },
});
const asked = (n: number, sequence: number, first: string, second: string): AgentEvent => ({
  ...said(n, sequence, ""),
  payload: {
    _tag: "TurnInput",
    items: [
      { _tag: "FromUser", text: first },
      { _tag: "FromUser", text: second },
    ],
  },
});

/** Three threads talking about the same things. */
const seed = Effect.gen(function* () {
  const store = yield* Store;
  for (const n of [1, 2, 3]) {
    yield* store.createThread(threadOf(n));
    yield* store.createAgent(leadOf(n));
    yield* store.appendEvents([
      said(n, 0, `The café checkout in thread ${n} is flaky`),
      asked(n, 1, `Rerun the checkout suite ${n}`, `And the crème brûlée one`),
    ]);
  }
});

const found = (typed: string) =>
  Store.use((store) => store.searchMessages(typed, { mode: "work", limit: 10 })).pipe(
    Effect.map((matches) => matches.map((match) => match.threadId).toSorted()),
  );

describe("message search", () => {
  it.effect("keeps an older index's messages when moving its text to a table indexed by thread", () =>
    Effect.gen(function* () {
      const folder = mkdtempSync(join(tmpdir(), "cerium-search-"));
      yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(folder, { recursive: true, force: true })));
      // A database last opened by a Cerium from before the migration.
      const older = join(folder, "migrations");
      cpSync(migrationsFolder, older, {
        recursive: true,
        filter: (source) => !source.includes(OWNER),
      });
      const filename = join(folder, "cerium.db");
      yield* seed.pipe(Effect.provide(Store.layer({ filename, migrationsFolder: older })));

      yield* Effect.gen(function* () {
        // Prefixes, diacritics and every message of a turn's input are found as before.
        assert.deepStrictEqual(yield* found("checkout"), ["thr_1", "thr_2", "thr_3"]);
        assert.deepStrictEqual(yield* found("cafe chec"), ["thr_1", "thr_2", "thr_3"]);
        assert.deepStrictEqual(yield* found("creme brulee"), ["thr_1", "thr_2", "thr_3"]);
        assert.deepStrictEqual(yield* found("suite 2"), ["thr_2"]);
        const [match] = yield* Store.use((store) =>
          store.searchMessages("flaky", { mode: "work", limit: 1 }),
        );
        assert.isTrue(match?.passage.some((piece) => piece.match && piece.text === "flaky"));

        yield* Store.use((store) => store.deleteThread(threadOf(2).id));
        assert.deepStrictEqual(yield* found("checkout"), ["thr_1", "thr_3"]);
        // Messages added after the migration are found, and go with their thread.
        yield* Store.use((store) => store.appendEvents([said(3, 2, "A brand new crème")]));
        assert.deepStrictEqual(yield* found("brand"), ["thr_3"]);
        yield* Store.use((store) => store.deleteThread(threadOf(3).id));
        assert.deepStrictEqual(yield* found("brand"), []);
        assert.deepStrictEqual(yield* found("checkout"), ["thr_1"]);
      }).pipe(Effect.provide(Store.layer({ filename, migrationsFolder })));

      const db = new DatabaseSync(filename);
      try {
        // The index matches the text it was built from, row for row.
        db.exec("INSERT INTO message_search (message_search, rank) VALUES ('integrity-check', 1)");
        assert.deepStrictEqual(
          db
            .prepare("SELECT thread_id AS thread, count(*) AS count FROM message_search_text GROUP BY 1")
            .all(),
          [{ thread: "thr_1", count: 3 }],
        );
        // A thread's rows are found through the index, not by reading every message.
        const plan = db
          .prepare("EXPLAIN QUERY PLAN DELETE FROM message_search_text WHERE thread_id = ?")
          .all("thr_1")
          .map((row) => String(row["detail"]));
        assert.isTrue(
          plan.some((detail) => detail.includes("USING COVERING INDEX message_search_text_thread")),
          plan.join("\n"),
        );
        const trigger = db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'threads_message_search'")
          .get();
        assert.include(
          String(trigger?.["sql"]),
          "DELETE FROM `message_search_text` WHERE `thread_id` = old.`id`",
        );
      } finally {
        db.close();
      }
    }).pipe(Effect.scoped),
  );
});
