import type { ThreadId, ThreadOverview, ThreadOverviewUpdate } from "@cerium/protocol";
import { applyOverviewUpdate } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { makeOverviewWatch } from "../src/overviewWatch.ts";

const overview = (id: string, title = id, archivedAt?: number): ThreadOverview => ({
  thread: {
    id: id as ThreadId,
    title,
    mode: "work",
    createdAt: 1,
    updatedAt: 1,
    ...(archivedAt === undefined ? {} : { archivedAt }),
  },
  agents: [],
  awaitingApproval: false,
});

describe("overview watch", () => {
  it.effect("sends only changes, retains archives, and resets every new subscription", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirty = yield* Queue.sliding<void>(1);
        let rows: ReadonlyArray<ThreadOverview> = [overview("a"), overview("b", "Archived", 10)];
        let reads = 0;
        const stream = yield* makeOverviewWatch(
          Effect.sync(() => {
            reads++;
            return rows;
          }),
          dirty,
        );
        const updates: ThreadOverviewUpdate[] = [];
        const ready = yield* Deferred.make<void>();
        yield* stream.pipe(
          Stream.runForEach((update) =>
            Effect.sync(() => updates.push(update)).pipe(Effect.andThen(Deferred.succeed(ready, undefined))),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(ready);
        assert.deepStrictEqual(updates[0], { _tag: "Reset", revision: 0, threads: rows });
        yield* TestClock.adjust("1 second");
        assert.strictEqual(reads, 1);
        rows = [overview("a", "Renamed"), rows[1]!];
        yield* Queue.offer(dirty, undefined);
        yield* TestClock.adjust("250 millis");
        assert.deepStrictEqual(updates[1], {
          _tag: "Patch",
          revision: 1,
          threads: [rows[0]!],
          removed: ["a" as ThreadId],
        });
        yield* Queue.offer(dirty, undefined);
        yield* TestClock.adjust("250 millis");
        assert.lengthOf(updates, 2);
        rows = [{ ...rows[0]!, awaitingApproval: true }];
        yield* Queue.offer(dirty, undefined);
        yield* TestClock.adjust("250 millis");
        assert.deepStrictEqual(updates[2], {
          _tag: "Patch",
          revision: 2,
          threads: rows,
          removed: ["b" as ThreadId, "a" as ThreadId],
        });
        const reset = yield* stream.pipe(Stream.take(1), Stream.runCollect);
        assert.deepStrictEqual(reset, [{ _tag: "Reset", revision: 2, threads: rows }]);
        assert.deepStrictEqual(
          updates.reduce(applyOverviewUpdate, [] as ReadonlyArray<ThreadOverview>),
          rows,
        );
      }),
    ),
  );

  it.effect("coalesces a slow viewer's missed revisions without losing earlier edits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dirty = yield* Queue.sliding<void>(1);
        let rows: ReadonlyArray<ThreadOverview> = [overview("a"), overview("b")];
        const stream = yield* makeOverviewWatch(
          Effect.sync(() => rows),
          dirty,
        );
        const paused = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const received: ThreadOverviewUpdate[] = [];
        const fiber = yield* stream.pipe(
          Stream.take(2),
          Stream.runForEach((update) =>
            Effect.gen(function* () {
              received.push(update);
              if (update._tag === "Reset") {
                yield* Deferred.succeed(paused, undefined);
                yield* Deferred.await(resume);
              }
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(paused);
        rows = [overview("a", "Rename while blocked"), rows[1]!];
        yield* Queue.offer(dirty, undefined);
        yield* TestClock.adjust("250 millis");
        rows = [rows[0]!, overview("b", "Now archived", 20)];
        yield* Queue.offer(dirty, undefined);
        yield* TestClock.adjust("250 millis");
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(fiber);
        assert.deepStrictEqual(received[1], {
          _tag: "Patch",
          revision: 2,
          threads: rows,
          removed: ["a" as ThreadId, "b" as ThreadId],
        });
        assert.deepStrictEqual(
          received.reduce(applyOverviewUpdate, [] as ReadonlyArray<ThreadOverview>),
          rows,
        );
      }),
    ),
  );
});
