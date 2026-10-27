import { UserSettings } from "@cerium/orchestrator";
import { Store } from "@cerium/store";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

import { threadSlimming } from "../src/slimming.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 27, 12);

/** A store that records the cut-off each slimming pass asks for, and slims nothing. */
const recordingStore = (cutoffs: Array<number>) =>
  Layer.effect(
    Store,
    Effect.gen(function* () {
      const store = yield* Store;
      return Store.of({
        ...store,
        slimThreads: (before) => Effect.sync(() => cutoffs.push(before)),
        reclaimSpace: Effect.void,
      });
    }),
  ).pipe(Layer.provide(Store.layer({ filename: ":memory:" })));

const testLayer = (cutoffs: Array<number>) =>
  threadSlimming.pipe(Layer.provideMerge(UserSettings.layer), Layer.provideMerge(recordingStore(cutoffs)));

describe("threadSlimming", () => {
  it.effect("slims a minute after starting, every six hours, and soon after the setting changes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const cutoffs: Array<number> = [];
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
      }).pipe(Effect.provide(testLayer(cutoffs)));
    }),
  );
});
