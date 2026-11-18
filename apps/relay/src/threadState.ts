import {
  ThreadStateCheckpoint,
  advanceThreadState,
  affectsThreadState,
  canAdvanceThreadState,
  compareHistory,
  emptyThreadState,
  isArtifactCandidate,
  type UiEvent,
  type CloudThreadStateView,
} from "@cerium/protocol";
import { and, asc, eq, gt } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { Option, Schema } from "effect";

import { eventBatches, stateBatches, stateChunks, threads } from "./schema.ts";

type View = CloudThreadStateView;
const decodeCheckpoint = Schema.decodeUnknownOption(Schema.fromJsonString(ThreadStateCheckpoint));

/** Each SQLite string stays below the relay's 2 MB row limit even for multibyte text. */
const CHUNK_SIZE = 200_000;

export class CloudThreadState {
  private readonly db: DrizzleSqliteDODatabase;
  private readonly machine: string;
  private readonly thread: string;

  constructor(db: DrizzleSqliteDODatabase, machine: string, thread: string) {
    this.db = db;
    this.machine = machine;
    this.thread = thread;
  }

  private readCheckpoint() {
    const rows = this.db
      .select({ json: stateChunks.json })
      .from(stateChunks)
      .where(and(eq(stateChunks.machine, this.machine), eq(stateChunks.thread, this.thread)))
      .orderBy(asc(stateChunks.part))
      .all();
    return Option.getOrUndefined(decodeCheckpoint(rows.map((row) => row.json).join("")));
  }

  private saveCheckpoint(state: ThreadStateCheckpoint) {
    const { machine, thread } = this;
    const json = JSON.stringify(state);
    let part = 0;
    // Split between Unicode code points so chunks written by SQLite round-trip exactly.
    for (let start = 0; start < json.length; part++) {
      let end = Math.min(start + CHUNK_SIZE, json.length);
      const last = json.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end--;
      const piece = json.slice(start, end);
      this.db
        .insert(stateChunks)
        .values({ machine, thread, part, json: piece })
        .onConflictDoUpdate({
          target: [stateChunks.machine, stateChunks.thread, stateChunks.part],
          set: { json: piece },
        })
        .run();
      start = end;
    }
    this.db
      .delete(stateChunks)
      .where(
        and(eq(stateChunks.machine, machine), eq(stateChunks.thread, thread), gt(stateChunks.part, part - 1)),
      )
      .run();
  }

  private indexBatch(start: number, events: ReadonlyArray<UiEvent>) {
    const { machine, thread } = this;
    const save = (view: typeof stateBatches.$inferSelect.view, selected: ReadonlyArray<UiEvent>) => {
      if (selected.length === 0) return;
      this.db
        .insert(stateBatches)
        .values({ machine, thread, view, start, events: JSON.stringify(selected) })
        .onConflictDoNothing()
        .run();
    };
    save("artifacts", events.filter(isArtifactCandidate));
    save(
      "files",
      events.filter((event) => event.payload._tag === "FileChanged"),
    );
  }

  /** Called with exactly the accepted suffix and inside its upload transaction. */
  append(start: number, previous: number | null, events: ReadonlyArray<UiEvent>): number | null {
    this.indexBatch(start, events);
    if (start !== 0 && previous !== start) return null;
    const inputs = events.filter(affectsThreadState);
    if (inputs.length > 0 || start === 0) {
      const state = start === 0 ? emptyThreadState() : this.readCheckpoint();
      if (state === undefined || !canAdvanceThreadState(state, inputs)) return null;
      this.saveCheckpoint(advanceThreadState(state, inputs));
    }
    return start + events.length;
  }

  private *uploads() {
    let after = -1;
    for (;;) {
      const batch = this.db
        .select()
        .from(eventBatches)
        .where(
          and(
            eq(eventBatches.machine, this.machine),
            eq(eventBatches.thread, this.thread),
            gt(eventBatches.start, after),
          ),
        )
        .orderBy(asc(eventBatches.start))
        .limit(1)
        .get();
      if (batch === undefined) return;
      yield { start: batch.start, events: JSON.parse(batch.events) as ReadonlyArray<UiEvent> };
      after = batch.start;
    }
  }

  /** One-time repair of cloud copies that predate the projection or received late imports. */
  private rebuild(count: number) {
    let state: ThreadStateCheckpoint | undefined = emptyThreadState();
    for (const { start, events } of this.uploads()) {
      this.indexBatch(start, events);
      if (state !== undefined)
        state = canAdvanceThreadState(state, events) ? advanceThreadState(state, events) : undefined;
    }
    // Normal copies can be folded a batch at a time. An import that went back in display order
    // needs one ordered fold of its state inputs.
    if (state === undefined) {
      const inputs: Array<UiEvent> = [];
      for (const { events } of this.uploads())
        for (const event of events) if (affectsThreadState(event)) inputs.push(event);
      state = advanceThreadState(emptyThreadState(), inputs);
    }
    this.saveCheckpoint(state);
    this.db
      .update(threads)
      .set({ stateEvents: count })
      .where(and(eq(threads.machine, this.machine), eq(threads.thread, this.thread)))
      .run();
    return state;
  }

  /** Upgraded copies read just the checkpoint and the requested panel's indexed entries. */
  read(view: View): ReadonlyArray<UiEvent> {
    const { machine, thread } = this;
    const stored = this.db
      .select({ events: threads.events, stateEvents: threads.stateEvents })
      .from(threads)
      .where(and(eq(threads.machine, machine), eq(threads.thread, thread)))
      .get();
    if (stored === undefined || stored.events === 0) return [];
    let state: ThreadStateCheckpoint | undefined;
    if (stored.stateEvents !== stored.events) state = this.rebuild(stored.events);
    if (view === "main") state ??= this.readCheckpoint() ?? this.rebuild(stored.events);
    const storedView = view === "main" ? "artifacts" : "files";
    const history = this.db
      .select({ events: stateBatches.events })
      .from(stateBatches)
      .where(
        and(
          eq(stateBatches.machine, machine),
          eq(stateBatches.thread, thread),
          eq(stateBatches.view, storedView),
        ),
      )
      .all()
      .flatMap((batch) => JSON.parse(batch.events) as ReadonlyArray<UiEvent>);
    if (view === "files") return history.sort(compareHistory);
    // The latest reply can itself be an artifact. Keep it once in display order for both readers.
    return [
      ...new Map([...history, ...(state?.events ?? [])].map((event) => [event.id, event])).values(),
    ].sort(compareHistory);
  }
}
