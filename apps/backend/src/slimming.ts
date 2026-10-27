import { UserSettings } from "@cerium/orchestrator";
import { Store } from "@cerium/store";
import { Clock, Duration, Effect, Layer, Schedule, Semaphore, Stream } from "effect";

// Old threads, slimmed: once nothing has happened in a thread for the days the user chose (Settings →
// General), its screenshots and the harnesses' payloads kept beside its events go, which are most of
// the database, and the space goes back to the disk. Its messages and tool text stay.

const DAY = 86_400_000;

/** After startup, out of the way of the first threads the window opens. */
const FIRST_PASS = Duration.minutes(1);

const EVERY = Duration.hours(6);

/** A change of the setting is acted on once the user has stopped changing it. */
const SETTLE = Duration.seconds(5);

/** Slims old threads now, after startup and every few hours, and soon after the setting changes. Requires `Store` and `UserSettings`. */
export const threadSlimming = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Store;
    const settings = yield* UserSettings;
    const lock = yield* Semaphore.make(1);

    const pass = Effect.gen(function* () {
      const { slimThreadsAfter } = yield* settings.get;
      if (slimThreadsAfter === 0) return;
      const now = yield* Clock.currentTimeMillis;
      const slimmed = yield* store.slimThreads(now - slimThreadsAfter * DAY);
      if (slimmed > 0) yield* Effect.logInfo(`Slimmed ${slimmed} quiet threads`);
      yield* store.reclaimSpace;
    }).pipe(
      Effect.catch((error) => Effect.logWarning(`Couldn't slim old threads: ${error.message}`)),
      (slimming) => lock.withPermit(slimming),
    );

    yield* Effect.sleep(FIRST_PASS).pipe(
      Effect.andThen(Effect.repeat(pass, Schedule.spaced(EVERY))),
      Effect.forkScoped,
    );
    yield* settings.changes.pipe(
      Stream.map((current) => current.slimThreadsAfter),
      Stream.changes,
      Stream.drop(1),
      Stream.debounce(SETTLE),
      Stream.runForEach(() => pass),
      Effect.forkScoped,
    );
  }),
);
