import { HarnessFailure, type HarnessAdapter } from "@cerium/harness";
import { Adapters, Orchestrator } from "@cerium/orchestrator";
import type { AgentEvent, AgentId, ProviderId, ProviderUsage, UsageSnapshot } from "@cerium/protocol";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Schedule,
  Stream,
  SubscriptionRef,
} from "effect";

/** How long a harness gets to report its usage before the page says it didn't. */
const USAGE_TIMEOUT = Duration.seconds(30);

/** Turns that end this close together are followed by one read. */
const TURN_SETTLE = Duration.seconds(5);

/**
 * The least time between the reads one harness's turns ask for. A busy agent ends many turns a
 * minute, and reading Claude's usage starts a whole Claude Code.
 */
const TURN_READ_GAP = Duration.minutes(1);

/** How often the usage is read again while someone watches it. */
const REFRESH_EVERY = Duration.minutes(5);

/**
 * One harness's usage as it reports it now: `None` when it isn't usable, can't report its limits
 * or has no subscription, and why it couldn't say when its read fails.
 */
export const readProviderUsage = ({
  provider,
  usage,
}: HarnessAdapter): Effect.Effect<Option.Option<ProviderUsage>> =>
  usage === undefined
    ? Effect.succeedNone
    : usage.pipe(
        Effect.timeoutOrElse({
          duration: USAGE_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new HarnessFailure({
                provider,
                message: "The harness didn't report its usage in time.",
                cause: null,
              }),
            ),
        }),
        Effect.flatMap((report) =>
          Clock.currentTimeMillis.pipe(
            Effect.map((checkedAt) =>
              Option.map(report, (value): ProviderUsage => ({
                _tag: "Subscribed",
                provider,
                ...value,
                checkedAt,
              })),
            ),
          ),
        ),
        Effect.catchTags({
          HarnessUnavailable: () => Effect.succeedNone,
          HarnessFailure: (error) =>
            Effect.succeedSome<ProviderUsage>({ _tag: "UsageUnreadable", provider, message: error.message }),
        }),
      );

/** A new reading over the last: a failed read keeps the last meters it had and says why. */
export const nextReading = (
  last: ProviderUsage | undefined,
  read: Option.Option<ProviderUsage>,
): ProviderUsage | undefined => {
  if (Option.isNone(read)) return undefined;
  const reading = read.value;
  if (reading._tag === "UsageUnreadable" && last?._tag === "Subscribed") {
    return { ...last, refreshError: reading.message };
  }
  return reading;
};

interface State {
  readonly readings: ReadonlyMap<ProviderId, ProviderUsage>;
  /** The harnesses being read right now. */
  readonly reading: ReadonlySet<ProviderId>;
}

/**
 * The usage of every subscribed harness, kept as last read. It is read again whenever someone starts
 * watching, a few seconds after a harness's turns end (at most once a minute) while someone watches,
 * and every five minutes while someone does; nobody watching, it reads nothing. The limit warnings
 * (limits.ts) always watch.
 */
export const makeSubscriptionUsage = Effect.fn("SubscriptionUsage.make")(function* (
  adapters: ReadonlyMap<ProviderId, HarnessAdapter>,
  events: Stream.Stream<AgentEvent>,
) {
  const state = yield* SubscriptionRef.make<State>({ readings: new Map(), reading: new Set() });
  const watchers = yield* Ref.make(0);
  const watched = Ref.get(watchers).pipe(Effect.map((count) => count > 0));
  const order = [...adapters.keys()];
  const snapshot = ({ readings, reading }: State): UsageSnapshot => ({
    usage: order.flatMap((provider) => {
      const each = readings.get(provider);
      return each === undefined ? [] : [each];
    }),
    checking: reading.size > 0,
  });

  /** Reads one harness, unless a read of it is already under way. */
  const readOne = (adapter: HarnessAdapter) =>
    Effect.gen(function* () {
      const started = yield* SubscriptionRef.modify(state, (current): [boolean, State] =>
        adapter.usage === undefined || current.reading.has(adapter.provider)
          ? [false, current]
          : [true, { ...current, reading: new Set([...current.reading, adapter.provider]) }],
      );
      if (!started) return;
      const read = yield* readProviderUsage(adapter);
      yield* SubscriptionRef.update(state, (current) => {
        const readings = new Map(current.readings);
        const next = nextReading(readings.get(adapter.provider), read);
        if (next === undefined) readings.delete(adapter.provider);
        else readings.set(adapter.provider, next);
        const reading = new Set(current.reading);
        reading.delete(adapter.provider);
        return { readings, reading };
      });
    });
  const readSome = (providers: Iterable<ProviderId>) =>
    Effect.forEach(
      [...new Set(providers)].flatMap((provider) => {
        const adapter = adapters.get(provider);
        return adapter === undefined ? [] : [adapter];
      }),
      readOne,
      { concurrency: "unbounded", discard: true },
    );
  const readAll = readSome(order);

  // A harness's turns spend its limits: once they settle, its meters are read again for whoever
  // watches, and then not for its turns again for a minute. Turns that end meanwhile ask for one read
  // when the minute is up. A turn of an agent whose harness isn't known yet reads them all.
  const turnsEnded = new Map<ProviderId, Queue.Queue<void>>();
  for (const adapter of adapters.values()) {
    if (adapter.usage === undefined) continue;
    const ended = yield* Queue.dropping<void>(1);
    turnsEnded.set(adapter.provider, ended);
    yield* Queue.take(ended).pipe(
      Effect.andThen(Effect.sleep(TURN_SETTLE)),
      Effect.andThen(
        Effect.when(readOne(adapter).pipe(Effect.andThen(Effect.sleep(TURN_READ_GAP))), watched),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  }
  const providerOf = new Map<AgentId, ProviderId>();
  yield* events.pipe(
    Stream.runForEach(({ agentId, payload }) => {
      if (payload._tag === "SessionStarted") providerOf.set(agentId, payload.provider);
      if (payload._tag !== "TurnCompleted") return Effect.void;
      const provider = providerOf.get(agentId);
      const asked = [...turnsEnded].filter(([each]) => provider === undefined || each === provider);
      return Effect.forEach(asked, ([, ended]) => Queue.offer(ended, undefined), { discard: true });
    }),
    Effect.forkScoped,
  );
  yield* Effect.when(readAll, watched).pipe(Effect.repeat(Schedule.spaced(REFRESH_EVERY)), Effect.forkScoped);

  const watch: Stream.Stream<UsageSnapshot> = Stream.unwrap(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Ref.update(watchers, (count) => count + 1),
        () => Ref.update(watchers, (count) => count - 1),
      );
      // The read outlives a watcher that leaves before it ends, so the next one starts from it.
      yield* Effect.forkDetach(readAll);
      return SubscriptionRef.changes(state).pipe(Stream.map(snapshot));
    }),
  );
  return { watch };
});

export class SubscriptionUsage extends Context.Service<
  SubscriptionUsage,
  {
    /** The usage as last read, then every change, while the harnesses are read again. */
    readonly watch: Stream.Stream<UsageSnapshot>;
  }
>()("cerium/backend/SubscriptionUsage") {
  static readonly layer = Layer.effect(
    SubscriptionUsage,
    Effect.gen(function* () {
      const adapters = yield* Adapters;
      const orchestrator = yield* Orchestrator;
      return SubscriptionUsage.of(yield* makeSubscriptionUsage(adapters, orchestrator.events));
    }),
  );
}
