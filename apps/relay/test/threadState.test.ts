/// <reference types="node" />

import type { UiEvent } from "@cerium/protocol";
import { describe, expect, it } from "@effect/vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { eventBatches, threads } from "../src/schema.ts";
import { appendBatch } from "../src/sync.ts";
import { CloudThreadState } from "../src/threadState.ts";

const event = (sequence: number, payload: UiEvent["payload"]): UiEvent => ({
  id: `event-${sequence}` as UiEvent["id"],
  threadId: "thread" as UiEvent["threadId"],
  agentId: "agent" as UiEvent["agentId"],
  sequence,
  at: sequence,
  payload,
});

const message = (sequence: number, text: string) =>
  event(sequence, { _tag: "MessageCompleted", messageId: `message-${sequence}`, text });

describe("cloud thread state", () => {
  it("rebuilds an old copy once, appends an accepted suffix, and reads no uploads when current", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      for (const folder of ["20261021190217_initial", "20261118214852_thread_state"]) {
        sqlite.exec(
          readFileSync(join(import.meta.dirname, "..", "migrations", folder, "migration.sql"), "utf8"),
        );
      }
      let historyReads = 0;
      const db = drizzle({
        sql: {
          exec: (sql: string, ...bindings: ReadonlyArray<SQLInputValue>) => {
            if (sql.startsWith("select") && sql.includes('"event_batches"')) historyReads++;
            const statement = sqlite.prepare(sql);
            const cursor = (raw: boolean) => {
              statement.setReturnArrays(raw);
              const result = statement.all(...bindings);
              return { toArray: () => result, next: () => ({ value: result[0] }) };
            };
            return { ...cursor(false), raw: () => cursor(true) };
          },
        },
      } as unknown as Parameters<typeof drizzle>[0]);
      const machine = "machine";
      const thread = "thread";
      const state = () => new CloudThreadState(db, machine, thread);
      const artifact = message(1, "old artifact");
      const reply = message(2, "old reply");
      const file = event(3, { _tag: "FileChanged", path: "main.ts", change: "modified" });
      const latest = message(4, "🪐".repeat(110_000));
      const write = (start: number, events: ReadonlyArray<UiEvent>) => {
        db.insert(eventBatches)
          .values({ machine, thread, start, events: JSON.stringify(events) })
          .run();
      };
      db.insert(threads).values({ machine, thread, overview: "{}", events: 2, updatedAt: 0 }).run();
      write(0, [artifact, reply]);

      expect(state().read("main")).toEqual([artifact, reply]);
      expect(historyReads).toBeGreaterThan(0);
      historyReads = 0;
      const upload = appendBatch(2, 1, [reply, file, latest]);
      write(2, upload.keep);
      const stateEvents = state().append(2, 2, upload.keep);
      db.update(threads).set({ events: upload.count, stateEvents }).where(eq(threads.thread, thread)).run();

      expect(state().read("main")).toEqual([artifact, latest]);
      expect(state().read("files")).toEqual([file]);
      expect(historyReads).toBe(0);
      expect(
        db
          .select()
          .from(eventBatches)
          .all()
          .flatMap((batch) => JSON.parse(batch.events)),
      ).toEqual([artifact, reply, file, latest]);
      const late = { ...message(5, "older by display order"), at: 1 };
      write(upload.count, [late]);
      expect(state().append(upload.count, upload.count, [late])).toBeNull();
      db.update(threads)
        .set({ events: upload.count + 1, stateEvents: null })
        .where(eq(threads.thread, thread))
        .run();
      expect(state().read("main")).toEqual([artifact, latest]);
      historyReads = 0;
      expect(state().read("main")).toEqual([artifact, latest]);
      expect(historyReads).toBe(0);
    } finally {
      sqlite.close();
    }
  });
});
