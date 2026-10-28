import { UserSettings } from "@cerium/orchestrator";
import { Store } from "@cerium/store";
import { Clock, Duration, Effect, Layer, Schedule, Semaphore, Stream } from "effect";

// Old threads, slimmed: once nothing has happened in a thread for the days the user chose (Settings →
// General), its screenshots go, which are most of the database, and the space goes back to the disk.
// Its messages and tool text stay. The harnesses' payloads older versions kept beside every event go
// from every thread, whatever the setting: nothing reads them.

const DAY = 86_400_000;

/** After startup, out of the way of the first threads the window opens. */
const FIRST_PASS = Duration.minutes(1);

const EVERY = Duration.hours(6);

/** A change of the setting is acted on once the user has stopped changing it. */
const SETTLE = Duration.seconds(5);

/**
 * How often a rewrite of the database file put off while agents work is tried again: the app's own
 * queries wait for it, which an agent's events shouldn't.
 */
const REWRITE_RETRY = Duration.minutes(10);

/** Slims old threads now, after startup and every few hours, and soon after the setting changes. Requires `Store` and `UserSettings`. */
export const threadSlimming = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Store;
    const settings = yield* UserSettings;
    const lock = yield* Semaphore.make(1);

    /** No agent works or waits to: the file can be rewritten without holding up a turn. */
    const idle = store.listAllAgents.pipe(
      Effect.map((agents) => !agents.some((agent) => agent.state === "running" || agent.state === "queued")),
    );

    /** Hands freed space back; resolves whether a rewrite is still due. */
    const reclaim = Effect.gen(function* () {
      return yield* store.reclaimSpace({ rewrite: yield* idle });
    });

    const pass = Effect.gen(function* () {
      const dropped = yield* store.dropHarnessPayloads;
      if (dropped > 0) yield* Effect.logInfo(`Dropped the harness payloads of ${dropped} events`);
      const { slimThreadsAfter } = yield* settings.get;
      if (slimThreadsAfter !== 0) {
        const now = yield* Clock.currentTimeMillis;
        const slimmed = yield* store.slimThreads(now - slimThreadsAfter * DAY);
        if (slimmed > 0) yield* Effect.logInfo(`Slimmed ${slimmed} quiet threads`);
      }
      return yield* reclaim;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`Couldn't slim old threads: ${error.message}`).pipe(Effect.as(false)),
      ),
      (slimming) => lock.withPermit(slimming),
    );

    /** A pass, then the rewrite it put off, once the agents stop. */
    const passAndRewrite = pass.pipe(
      Effect.flatMap((due) =>
        due
          ? reclaim.pipe(
              Effect.catch(() => Effect.succeed(false)),
              (attempt) => lock.withPermit(attempt),
              Effect.delay(REWRITE_RETRY),
              Effect.repeat({ while: (pending) => pending }),
            )
          : Effect.void,
      ),
      Effect.asVoid,
    );

    yield* Effect.sleep(FIRST_PASS).pipe(
      Effect.andThen(Effect.repeat(passAndRewrite, Schedule.spaced(EVERY))),
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
