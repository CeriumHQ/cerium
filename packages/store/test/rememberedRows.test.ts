import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option } from "effect";
import { rememberedRows } from "../src/rememberedRows.ts";

describe("remembered metadata rows", () => {
  it.effect("refreshes only the changed row and preserves every other row's identity", () =>
    Effect.gen(function* () {
      let rows = [
        { id: "a", createdAt: 1, title: "A" },
        { id: "b", createdAt: 2, title: "B" },
      ];
      let fullReads = 0,
        oneReads = 0,
        changes = 0;
      const cache = rememberedRows(
        Effect.sync(() => {
          fullReads++;
          return [...rows];
        }),
        (id) =>
          Effect.sync(() => {
            oneReads++;
            return Option.fromNullishOr(rows.find((row) => row.id === id));
          }),
        Effect.sync(() => {
          changes++;
        }),
      );
      const first = yield* cache.read;
      yield* Effect.sync(() => {
        rows = [{ ...rows[0]!, title: "Renamed" }, rows[1]!];
      }).pipe(cache.changed("a"));
      const next = yield* cache.read;
      assert.strictEqual(next[0]!.title, "Renamed");
      assert.strictEqual(next[1], first[1]);
      assert.deepStrictEqual({ fullReads, oneReads, changes }, { fullReads: 1, oneReads: 1, changes: 1 });
      yield* Effect.sync(() => {
        rows = rows.slice(1);
      }).pipe(cache.forget);
      assert.deepStrictEqual(yield* cache.read, rows);
      assert.strictEqual(fullReads, 2);
    }),
  );
  it.effect("does not keep a list read overtaken by a write", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>(),
          resume = yield* Deferred.make<void>();
        let title = "Before",
          reads = 0;
        const cache = rememberedRows(
          Effect.gen(function* () {
            reads++;
            const row = { id: "a", createdAt: 1, title };
            if (reads === 1) {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(resume);
            }
            return [row];
          }),
          () => Effect.succeed(Option.none()),
          Effect.void,
        );
        const read = yield* cache.read.pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* Effect.sync(() => {
          title = "After";
        }).pipe(cache.changed("a"));
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(read);
        assert.strictEqual((yield* cache.read)[0]!.title, "After");
        assert.strictEqual(reads, 2);
      }),
    ),
  );
});
