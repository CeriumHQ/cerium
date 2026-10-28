import { UserSettings } from "@cerium/orchestrator";
import type { AgentInfo } from "@cerium/protocol";
import { Store } from "@cerium/store";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

import { threadSlimming } from "../src/slimming.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 27, 12);

interface Recorded {
  readonly cutoffs: Array<number>;
  /** Whether each reclaim was allowed to rewrite the file. */
  readonly reclaims: Array<boolean>;
  /** Whether an agent is working, and whether a rewrite is due. */
  working: boolean;
  due: boolean;
}

const recorded = (): Recorded => ({ cutoffs: [], reclaims: [], working: false, due: false });

/** A store that records what each slimming pass asks of it, and slims nothing. */
const recordingStore = (record: Recorded) =>
  Layer.effect(
    Store,
    Effect.gen(function* () {
      const store = yield* Store;
      return Store.of({
        ...store,
        listAllAgents: Effect.sync(() =>
          record.working ? [{ state: "running" } as AgentInfo] : ([] as ReadonlyArray<AgentInfo>),
        ),
        slimThreads: (before) => Effect.sync(() => record.cutoffs.push(before)),
        dropHarnessPayloads: Effect.succeed(0),
        reclaimSpace: ({ rewrite }) =>
          Effect.sync(() => {
            record.reclaims.push(rewrite);
            if (rewrite) record.due = false;
            return record.due;
          }),
      });
    }),
  ).pipe(Layer.provide(Store.layer({ filename: ":memory:" })));

const testLayer = (record: Recorded) =>
  threadSlimming.pipe(Layer.provideMerge(UserSettings.layer), Layer.provideMerge(recordingStore(record)));

describe("threadSlimming", () => {
  it.effect("slims a minute after starting, every six hours, and soon after the setting changes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const record = recorded();
      const { cutoffs } = record;
      yield* Effect.gen(function* () {
        const settings = yield* UserSettings;
        yield* TestClock.adjust(MINUTE - 1);
        assert.deepStrictEqual(cutoffs, []);
        yield* TestClock.adjust(1);
        // A week by default.
        assert.deepStrictEqual(cutoffs, [NOW + MINUTE - 7 * DAY]);

        yield* settings.update({ slimThreadsAfter: 1 });
        yield* TestClock.adjust(4_999);
        assert.lengthOf(cutoffs, 1);
        yield* TestClock.adjust(1);
        assert.deepStrictEqual(cutoffs.at(-1), NOW + MINUTE + 5_000 - DAY);

        yield* TestClock.adjust(6 * HOUR);
        assert.deepStrictEqual(cutoffs.at(-1), NOW + MINUTE + 6 * HOUR - DAY);

        yield* settings.update({ slimThreadsAfter: 0 });
        yield* TestClock.adjust(12 * HOUR);
        assert.lengthOf(cutoffs, 3, "never slims once turned off");
      }).pipe(Effect.provide(testLayer(record)));
    }),
  );

  it.effect("puts off rewriting the database file while an agent works, trying again until none does", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const record = recorded();
      record.working = true;
      record.due = true;
      yield* Effect.gen(function* () {
        yield* TestClock.adjust(MINUTE);
        assert.deepStrictEqual(record.reclaims, [false]);
        yield* TestClock.adjust(10 * MINUTE);
        assert.deepStrictEqual(record.reclaims, [false, false]);
        record.working = false;
        yield* TestClock.adjust(10 * MINUTE);
        assert.deepStrictEqual(record.reclaims, [false, false, true]);
        yield* TestClock.adjust(60 * MINUTE);
        assert.lengthOf(record.reclaims, 3, "nothing more until the next pass");
      }).pipe(Effect.provide(testLayer(record)));
    }),
  );
});
