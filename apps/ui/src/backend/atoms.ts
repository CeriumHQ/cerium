import {
  applyOverviewUpdate,
  affectsThreadState,
  isArtifactCandidate,
  isStreamDelta,
  ModelInfo,
  OFFERED_PROVIDERS,
  type AccountDrafts,
  type AccountTasks,
  type AccessMode,
  type AccountThreads,
  type AgentEvent,
  type AgentId,
  type DeviceId,
  type EventPayload,
  type HistoryCursor,
  type LiveEventDelivery,
  type PastSession,
  type ProviderId,
  type TaskEntry,
  type ThreadId,
  type ThreadNotification,
  type ThreadOverview,
  type CloudThreadStateView,
  type ThreadStateView,
} from "@cerium/protocol";
import { HARNESS_PROVIDERS_HEADER, SCOPED_EVENTS_RPC_VERSION } from "@cerium/rpc";
import { Clock, Effect, Equal, Option, PubSub, Schedule, Schema, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { remember, stored } from "../lib/storage.ts";
import { Backend, BackendUnreachable, connectionAtom, connectionEpochAtom, LocalBackend } from "./client.ts";
import { machineAtom, machineKey, type DrivenMachine } from "./machine.ts";
import { fillGap, jumpThrough, type Gap } from "./deepJump.ts";
import { byTime, inHistoryWindow, ThreadLog } from "./threadLog.ts";

/** Live feeds end when the connection drops; this picks them back up once it returns. */
const resubscribe = Stream.retry(Schedule.spaced("1 second"));

/** What the window's live feed carries: each event, and a mark each time it subscribes again. */
type Live = { readonly _tag: "Event"; readonly event: AgentEvent } | { readonly _tag: "Subscribed" };

const subscribed: Live = { _tag: "Subscribed" };
const isKnownDelivery = (delivery: LiveEventDelivery): delivery is Live =>
  delivery._tag === "Subscribed" || delivery.event !== undefined;

/**
 * How many events the live subscription holds before the socket waits for the window to take them.
 * The socket reads every answer in turn, so a subscription that makes it wait holds up all the
 * others: the thread list, the open thread and every call the window makes.
 */
const LIVE_BUFFER = 4096;

/**
 * The driven machine's activity on one subscription the whole window shares. Older machines send
 * text on this feed too. Readers catch up when the server confirms each subscription, or when a
 * legacy request is on its way. A line that's coming back is subscribed to again at once.
 */
const liveFeedAtom = Backend.runtime
  .atom((get) => {
    const scoped = get(scopedEventsSupportedAtom);
    return Effect.gen(function* () {
      const feed = yield* PubSub.unbounded<Live>();
      const subscribe = Effect.gen(function* () {
        const client = yield* Backend;
        if (scoped) {
          const events = yield* client("WatchActivity", undefined, {
            headers: { "cerium-activity": "without-tools" },
            asQueue: true,
            streamBufferSize: LIVE_BUFFER,
          });
          return yield* Stream.fromQueue(events).pipe(
            Stream.runForEachArray((batch) => PubSub.publishAll(feed, batch.filter(isKnownDelivery))),
          );
        }
        const events = yield* client("WatchEvents", undefined, {
          asQueue: true,
          streamBufferSize: LIVE_BUFFER,
        });
        yield* PubSub.publish(feed, subscribed);
        yield* Stream.fromQueue(events).pipe(
          Stream.runForEachArray((batch) =>
            PubSub.publishAll(
              feed,
              batch.flatMap((event): ReadonlyArray<Live> =>
                event === undefined ? [] : [{ _tag: "Event", event }],
              ),
            ),
          ),
        );
      }).pipe(Effect.scoped);
      yield* subscribe.pipe(
        Effect.ignoreCause,
        Effect.andThen(
          Effect.suspend(() =>
            get.registry.get(connectionAtom) === "reconnecting" ? Effect.void : Effect.sleep("1 second"),
          ),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
      return feed;
    });
  })
  .pipe(Atom.keepAlive);

/** A reader's own subscription to the live feed, open while its stream runs. */
const subscribeLive = (get: Atom.AtomContext) => Effect.flatMap(get.result(liveFeedAtom), PubSub.subscribe);

/** Anything but streamed text, and each new subscription, after which what was read is stale. */
const isActivity = (live: Live) => live._tag === "Subscribed" || !isStreamDelta(live.event.payload._tag);

/**
 * Whether two reads of an atom hold the same: in the same state, with values `same` finds equal. An
 * atom whose new read is the same keeps its old one and wakes none of its readers.
 */
const sameRead =
  <A>(same: (a: A, b: A) => boolean) =>
  (a: AsyncResult.AsyncResult<A, unknown>, b: AsyncResult.AsyncResult<A, unknown>): boolean =>
    a._tag === b._tag &&
    a.waiting === b.waiting &&
    (AsyncResult.isSuccess(a) && AsyncResult.isSuccess(b) ? same(a.value, b.value) : a === b);

/** The least time between two reads of the thread list, in milliseconds. */
const LIST_SPACING = 250;

/** Local UI and backend ship together. Remote capabilities come from the account's device roster. */
export const drivenRpcVersionAtom = Atom.make((get) => {
  const machine = get(machineAtom);
  if (machine === undefined) return Infinity;
  const state = AsyncResult.getOrElse(get(accountAtom), () => undefined);
  return state?._tag === "SignedIn"
    ? (state.devices.find((device) => device.id === machine.id)?.rpcVersion ?? 0)
    : 0;
});
const overviewWatchSupportedAtom = Atom.make((get) => get(drivenRpcVersionAtom) >= 46);
const scopedEventsSupportedAtom = Atom.make((get) => get(drivenRpcVersionAtom) >= SCOPED_EVENTS_RPC_VERSION);

/** Ticks whenever something other than streamed text happens; lists re-fetch on it. */
export const activityAtom = Backend.runtime.atom((get) =>
  Stream.unwrap(
    Effect.map(subscribeLive(get), (live) =>
      Stream.fromSubscription(live).pipe(
        Stream.filter(isActivity),
        Stream.scan(
          () => 0,
          (count: number) => count + 1,
        ),
      ),
    ),
  ),
);

/**
 * A full overview snapshot on connection, followed by changed rows, including archived threads.
 * Older remote backends retain the event-driven list read, with a slow sweep for metadata changes
 * that emit no events. Reconnecting starts a fresh snapshot while the last result stays visible.
 */
export const threadsAtom = Backend.runtime
  .atom((get) => {
    get(machineAtom);
    get(connectionEpochAtom);
    const watches = get(overviewWatchSupportedAtom);
    const connection = get.once(connectionAtom);
    if (connection === "connecting" || connection === "unreachable") {
      return Stream.fail(new BackendUnreachable({ message: "The machine isn't connected." }));
    }
    if (watches) {
      return Stream.unwrap(
        Backend.use((client) =>
          Effect.succeed(client("WatchThreadOverviews", undefined, { streamBufferSize: 1 })),
        ),
      ).pipe(
        resubscribe,
        Stream.mapAccum(
          (): ReadonlyArray<ThreadOverview> => [],
          (current, update) => {
            const next = applyOverviewUpdate(current, update);
            return [next, [next]] as const;
          },
        ),
      );
    }
    get.mount(liveFeedAtom);
    const listThreads = Backend.use((client) => client("ListThreads", undefined));
    // While agents work, events keep coming and reads would follow one another without a break,
    // each decoding and comparing every thread; a read waits until `LIST_SPACING` after the last.
    let readAt = Number.NEGATIVE_INFINITY;
    const read = Effect.gen(function* () {
      const wait = readAt + LIST_SPACING - (yield* Clock.currentTimeMillis);
      if (wait > 0) yield* Effect.sleep(wait);
      readAt = yield* Clock.currentTimeMillis;
      return yield* listThreads;
    });
    return Stream.unwrap(
      Effect.map(subscribeLive(get), (live) =>
        Stream.concat(
          Stream.succeed(subscribed),
          Stream.fromSubscription(live).pipe(Stream.filter(isActivity)),
        ),
      ),
    ).pipe(
      Stream.merge(Stream.tick("15 seconds")),
      Stream.buffer({ capacity: 1, strategy: "sliding" }),
      Stream.mapEffect(() => read),
      resubscribe,
    );
  })
  .pipe(Atom.withEquality(sameRead(Equal.equals)));

export const harnessesAtom = Backend.runtime.atom((get) => {
  get(connectionEpochAtom);
  return Backend.use((client) =>
    client("HarnessStatuses", undefined, {
      headers: { [HARNESS_PROVIDERS_HEADER]: OFFERED_PROVIDERS.join(",") },
    }),
  ).pipe(
    // The status check may have discovered an external sign-in or update and invalidated its list.
    Effect.tap(() => Effect.sync(() => get.refresh(modelsAtom))),
  );
});

/** What each harness can do. A machine too old to say fails it, and offers nothing that needs it. */
export const manifestsAtom = Backend.runtime.atom((get) => {
  get(connectionEpochAtom);
  return Backend.use((client) => client("HarnessManifests", undefined));
});

/**
 * The user's own sessions with the harnesses that a thread could take over, newest first. Read once
 * something asks, as listing them wakes each harness; a machine too old to list them fails it.
 */
export const pastSessionsAtom = Backend.runtime.atom((get) => {
  get(connectionEpochAtom);
  return Backend.use((client) => client("ListPastSessions", undefined));
});

/** Brings sessions in as threads, then reads the thread list and the sessions left again. */
export const importSessions = Backend.runtime.fn<{
  readonly sessions: ReadonlyArray<PastSession>;
  readonly access: AccessMode;
  readonly archiveBefore?: number;
}>()((payload, get) =>
  Backend.use((client) => client("ImportSessions", payload)).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        get.refresh(threadsAtom);
        get.refresh(pastSessionsAtom);
      }),
    ),
  ),
);

/**
 * Threads just brought in, for the window to mark seen: they arrive with their own past activity,
 * which isn't news.
 */
export const importedThreadsAtom = Atom.make<
  ReadonlyArray<{ readonly id: string; readonly updatedAt: number }>
>([]).pipe(Atom.keepAlive);

const providers = OFFERED_PROVIDERS;
const MODELS_KEY = "cerium:models";
const CachedModels = Schema.fromJsonString(Schema.Array(ModelInfo));

/**
 * The last lists the driven machine's harnesses gave, so the model pickers fill in before they
 * answer again. Each machine has its own: their harnesses differ.
 */
const cachedModels = (machine: DrivenMachine | undefined): ReadonlyArray<ModelInfo> =>
  Schema.decodeUnknownOption(CachedModels)(stored(machineKey(MODELS_KEY, machine))).pipe(
    Option.getOrElse(() => []),
  );

/**
 * Every harness's models, in provider order. Each provider's list replaces its cached one as soon as
 * that harness answers; one that can't be used offers none. Re-read after a reconnect.
 */
export const modelsAtom = Backend.runtime.atom(
  (get) => {
    get(connectionEpochAtom);
    const machine = get(machineAtom);
    return Stream.unwrap(
      Backend.use((client) =>
        Effect.succeed(
          Stream.mergeAll(
            providers.map((provider) =>
              Stream.fromEffect(
                client("ListModels", { provider }).pipe(
                  Effect.orElseSucceed((): ReadonlyArray<ModelInfo> => []),
                  Effect.map((models) => ({ provider, models })),
                ),
              ),
            ),
            { concurrency: "unbounded" },
          ),
        ),
      ),
    ).pipe(
      Stream.scan(
        () => cachedModels(machine),
        (current, answer) => {
          const next = providers.flatMap((provider) =>
            provider === answer.provider
              ? answer.models
              : current.filter((model) => model.provider === provider),
          );
          remember(machineKey(MODELS_KEY, machine), Schema.encodeSync(CachedModels)(next));
          return next;
        },
      ),
    );
  },
  { initialValue: cachedModels(undefined) },
);

/**
 * A harness's browser sign-in, running while something reads it: letting go of it cancels the
 * sign-in. Its value is the latest step.
 */
export const loginAtom = Atom.family((provider: ProviderId) =>
  Backend.runtime.atom(
    Stream.unwrap(Backend.use((client) => Effect.succeed(client("LoginHarness", { provider })))),
  ),
);

/**
 * This machine's Cerium account: signed out, signing in, or signed in with
 * the account's devices. Picked back up after a reconnect.
 */
export const accountAtom = LocalBackend.runtime.atom(
  Stream.unwrap(LocalBackend.use((client) => Effect.succeed(client("WatchAccount", undefined)))).pipe(
    resubscribe,
  ),
);

/**
 * Every thread of the account, on whichever machine, and what was seen of them on any
 * device. Empty while signed out.
 */
export const accountThreadsAtom = LocalBackend.runtime.atom(
  Stream.unwrap(LocalBackend.use((client) => Effect.succeed(client("WatchAccountThreads", undefined)))).pipe(
    resubscribe,
  ),
  { initialValue: { threads: [], read: [] } satisfies AccountThreads },
);

/** The account's drafts as this device last heard them, and whether it has heard since connecting. */
export const accountDraftsAtom = LocalBackend.runtime.atom(
  Stream.unwrap(LocalBackend.use((client) => Effect.succeed(client("WatchAccountDrafts", undefined)))).pipe(
    resubscribe,
  ),
  { initialValue: { ready: false, drafts: [] } satisfies AccountDrafts },
);

/** The account's tasks as this device last heard them, and whether it has heard since connecting. */
export const accountTasksAtom = LocalBackend.runtime.atom(
  Stream.unwrap(LocalBackend.use((client) => Effect.succeed(client("WatchAccountTasks", undefined)))).pipe(
    resubscribe,
  ),
  { initialValue: { ready: false, tasks: [] } satisfies AccountTasks },
);

/** A notification from this computer's own threads, numbered in the order it arrived. */
export interface Arrived {
  readonly seq: number;
  readonly notification: ThreadNotification;
}

/** How many of the latest notifications the window holds; more never arrive between two renders. */
const ARRIVED_KEPT = 16;

/**
 * This computer's own threads' latest notifications, whatever machine the window drives, picked
 * back up after a reconnect. Empty in the web client, whose notifications come by Web Push.
 */
export const notificationsAtom = LocalBackend.runtime.atom(
  Stream.unwrap(LocalBackend.use((client) => Effect.succeed(client("WatchNotifications", undefined)))).pipe(
    resubscribe,
    Stream.scan(
      (): ReadonlyArray<Arrived> => [],
      (kept, notification): ReadonlyArray<Arrived> => [
        ...kept.slice(1 - ARRIVED_KEPT),
        { seq: (kept.at(-1)?.seq ?? 0) + 1, notification },
      ],
    ),
  ),
  { initialValue: [] as ReadonlyArray<Arrived> },
);

/** A thread of another machine, read from the cloud copy. Keyed `machine:thread`. */
const olderCloudAtom = Atom.family((_key: string) => Atom.make(0));
export const cloudHistoryAtom = Atom.family((key: string) => {
  const split = key.indexOf(":");
  const machine = key.slice(0, split) as DeviceId;
  const threadId = key.slice(split + 1) as ThreadId;
  return LocalBackend.runtime
    .atom((get) => {
      const log = new ThreadLog();
      let before: number | undefined;
      let more = true;
      let target: HistoryCursor | undefined;
      let pageRevision = 0;
      let loadError: string | undefined;
      const loadOlder = () => get.set(olderCloudAtom(key), get.registry.get(olderCloudAtom(key)) + 1);
      const loadThrough = (cursor: HistoryCursor) => {
        target = cursor;
        loadOlder();
      };
      return Stream.concat(
        Stream.succeed(0),
        get.stream(olderCloudAtom(key), { withoutInitialValue: true }),
      ).pipe(
        Stream.mapEffect(() =>
          LocalBackend.use((client) =>
            client("CloudThreadHistory", { machine, threadId, ...(before === undefined ? {} : { before }) }),
          ).pipe(
            Effect.option,
            Effect.map((read) => {
              pageRevision++;
              loadError = Option.isNone(read) ? "Earlier messages couldn't load. Try again." : undefined;
              if (Option.isSome(read)) {
                if (more) log.add(read.value.events);
                before = read.value.before;
                more = read.value.more;
                if (target && !log.hasEvent(target.id) && more) loadOlder();
                else target = undefined;
              }
              return { ...log.state(), more, loadOlder, loadThrough, pageRevision, loadError };
            }),
          ),
        ),
      );
    })
    .pipe(Atom.setIdleTTL("5 minutes"));
});

/** Cloud side panels read their projection. Older relays return ordinary history pages. */
const cloudSideEvents = (state: CloudThreadStateView) =>
  Atom.family((key: string) =>
    LocalBackend.runtime
      .atom(() =>
        LocalBackend.use((client) =>
          Effect.gen(function* () {
            const split = key.indexOf(":");
            const machine = key.slice(0, split) as DeviceId;
            const threadId = key.slice(split + 1) as ThreadId;
            const log = new ThreadLog();
            let before: number | undefined;
            for (;;) {
              const page = yield* client("CloudThreadHistory", {
                machine,
                threadId,
                state,
                ...(before === undefined ? {} : { before }),
              });
              log.add(page.events.filter((event) => relevantTo(state, event)));
              if (!page.more || page.before === undefined) break;
              before = page.before;
              yield* Effect.yieldNow;
            }
            return log.state().settled;
          }),
        ),
      )
      .pipe(Atom.setIdleTTL("5 minutes")),
  );

export const cloudEventsAtom = cloudSideEvents("main");
export const cloudFileChangesAtom = cloudSideEvents("files");

/** Read only on an explicit find/jump: every message, in bounded pages, with no tool output. */
export const readSearchHistory = Atom.family((key: string) =>
  Backend.runtime.fn<void>()(() =>
    Backend.use((client) =>
      Effect.gen(function* () {
        const [threadId, agentId, cloud] = JSON.parse(key) as [ThreadId, AgentId, string | null];
        const collected: Array<ReadonlyArray<AgentEvent>> = [];
        let before: number | undefined;
        if (cloud !== null) return [] as ReadonlyArray<AgentEvent>;
        for (;;) {
          const page = yield* client("ThreadMessagePage", {
            agentId,
            ...(before === undefined ? {} : { before }),
          });
          collected.push(page.events);
          if (!page.more || page.before === undefined) break;
          before = page.before;
          yield* Effect.yieldNow;
        }
        // Keep the key tied to its thread even though the RPC's agent uniquely identifies it.
        return collected
          .reverse()
          .flat()
          .filter((event) => event.threadId === threadId);
      }),
    ),
  ),
);

export const readCloudSearchHistory = Atom.family((key: string) =>
  LocalBackend.runtime.fn<void>()(() =>
    LocalBackend.use((client) =>
      Effect.gen(function* () {
        const split = key.indexOf(":");
        const machine = key.slice(0, split) as DeviceId;
        const threadId = key.slice(split + 1) as ThreadId;
        const batches: Array<ReadonlyArray<AgentEvent>> = [];
        let before: number | undefined;
        for (;;) {
          const page = yield* client("CloudThreadHistory", {
            machine,
            threadId,
            ...(before === undefined ? {} : { before }),
          });
          batches.push(
            page.events.filter(
              (event) =>
                event.payload._tag === "TurnInput" ||
                event.payload._tag === "MessageCompleted" ||
                event.payload._tag === "ConversationRewound",
            ),
          );
          if (!page.more || page.before === undefined) break;
          before = page.before;
          yield* Effect.yieldNow;
        }
        return batches.reverse().flat();
      }),
    ),
  ),
);

/** The user's settings the backend applies, re-read after a reconnect. */
export const settingsAtom = Backend.runtime.atom((get) => {
  get(connectionEpochAtom);
  return Backend.use((client) => client("Settings", undefined));
});

/**
 * Whether the driven machine has an OpenRouter key for the effort router, and what its decisions
 * cost. Re-read after a reconnect; a machine too old for the router fails it.
 */
/** The assistants connected to the account, and the address they connect to; read again on refresh. */
export const assistantsAtom = LocalBackend.runtime.atom(
  LocalBackend.use((client) => client("ListAssistants", undefined)),
);

export const effortRouterStatusAtom = Backend.runtime.atom((get) => {
  get(connectionEpochAtom);
  return Backend.use((client) => client("EffortRouterStatus", undefined));
});

/** Keep a recently closed thread's history without leaving its transcript subscribed. */
const CLOSED_THREAD_TTL = "5 minutes";
const threadHistoryCache = Atom.family((_key: string) =>
  Atom.make(() => ({
    log: new ThreadLog(),
    after: undefined as number | undefined,
    before: undefined as HistoryCursor | undefined,
    more: true,
    loaded: false,
    /** Stretches a deep jump skipped the tool calls of, until they're asked for. */
    gaps: [] as Array<Gap>,
    /** Pages an unfinished jump has read the ordinary way, before it turns to the quick one. */
    hops: 0,
  })).pipe(Atom.setIdleTTL(CLOSED_THREAD_TTL)),
);
const olderThreadAtom = Atom.family((_id: ThreadId) => Atom.make(0));
const fillThreadAtom = Atom.family((_id: ThreadId) => Atom.make(0));
/** A jump this many full pages deep reads only state events for the rest of the way. Since RPC_VERSION 47. */
const DEEP_JUMP_PAGES = 2;
const STATE_HISTORY_RPC_VERSION = 47;
const historyTargetAtom = Atom.family((_id: ThreadId) => Atom.make<HistoryCursor | undefined>(undefined));

const threadLive = (get: Atom.AtomContext, threadId: ThreadId, scoped: boolean) =>
  scoped
    ? Stream.unwrap(
        Backend.use((client) =>
          Effect.succeed(client("WatchThreadEvents", { threadId }, { streamBufferSize: LIVE_BUFFER })),
        ),
      ).pipe(
        Stream.filter(isKnownDelivery),
        // Keep draining the socket while history catches up on the same connection.
        Stream.bufferArray({ capacity: "unbounded" }),
        Stream.repeat(Schedule.spaced("1 second")),
      )
    : Stream.unwrap(
        Effect.map(subscribeLive(get), (live) =>
          Stream.concat(Stream.succeed(subscribed), Stream.fromSubscription(live)).pipe(
            Stream.filter((each) => each._tag === "Subscribed" || each.event.threadId === threadId),
          ),
        ),
      );

/**
 * A thread's events: its history merged with live events, streamed text included. History is read
 * once subscribed to the live feed and again each time the feed subscribes again, so nothing falls
 * in between, even across a reconnect. Events are taken a batch at a time, which is what keeps a
 * fast reply in a long thread from outrunning the window.
 */
export const threadEventsAtom = Atom.family((threadId: ThreadId) =>
  Backend.runtime.atom((get) => {
    const machine = get(machineAtom);
    const scoped = get(scopedEventsSupportedAtom);
    const cache = get(threadHistoryCache(machineKey(threadId, machine)));
    const { log } = cache;
    let pageRevision = 0;
    let loadError: string | undefined;
    const loadOlder = () =>
      get.set(olderThreadAtom(threadId), get.registry.get(olderThreadAtom(threadId)) + 1);
    const loadThrough = (cursor: HistoryCursor) => get.set(historyTargetAtom(threadId), { ...cursor });
    const fillGaps = () => get.set(fillThreadAtom(threadId), get.registry.get(fillThreadAtom(threadId)) + 1);
    const state = () => ({
      ...log.state(),
      more: cache.more,
      loadOlder,
      loadThrough,
      pageRevision,
      loadError,
      ...(cache.gaps.length > 0 ? { skipped: true, fillGaps } : {}),
    });
    const pageRequest = (request: { readonly before: HistoryCursor; readonly state?: boolean }) => ({
      threadId,
      page: { before: request.before, ...(request.state === true ? { state: true } : {}) },
    });
    const history = (older: boolean) =>
      Backend.use((client) =>
        Effect.gen(function* () {
          const version = get.registry.get(drivenRpcVersionAtom);
          if (version < 45) {
            log.add(yield* client("ThreadEvents", { threadId, withoutImages: true, streamed: true }));
            cache.more = false;
            return;
          }
          if (older && (!cache.more || cache.before === undefined)) return;
          // Subscribe first, then read. Live events queue while every missed durable page is taken.
          // Only durable reads advance after: a live event may still be waiting to be persisted.
          do {
            const initial = cache.after === undefined;
            const page = yield* client("ThreadHistory", {
              threadId,
              page: older ? { before: cache.before! } : initial ? {} : { after: cache.after! },
            });
            log.add(
              older || initial
                ? page.events
                : page.events.filter((event) => inHistoryWindow(event, cache.before, cache.more)),
            );
            if (older || initial) {
              cache.before = page.before;
              cache.more = page.more;
            }
            if (!older) cache.after = page.after;
            if (older || initial || !page.more) break;
          } while (true);
        }),
      );
    return Stream.concat(
      cache.loaded ? Stream.succeed(state()) : Stream.empty,
      threadLive(get, threadId, scoped).pipe(
        Stream.merge(
          get
            .stream(olderThreadAtom(threadId), { withoutInitialValue: true })
            .pipe(Stream.map(() => ({ _tag: "Older" as const }))),
        ),
        Stream.merge(
          get
            .stream(fillThreadAtom(threadId), { withoutInitialValue: true })
            .pipe(Stream.map(() => ({ _tag: "Fill" as const }))),
        ),
        Stream.merge(
          get.stream(historyTargetAtom(threadId), { withoutInitialValue: true }).pipe(
            Stream.filter((cursor) => cursor !== undefined),
            Stream.map((cursor) => ({ _tag: "Through" as const, cursor })),
          ),
        ),
        Stream.chunks,
        Stream.mapEffect((batch) =>
          Effect.gen(function* () {
            // History can contain a completion of a queued live delta: complete first, then dedupe live.
            let changed = false;
            if (batch.some((each) => each._tag === "Subscribed")) {
              yield* history(false);
              cache.loaded = true;
              changed = true;
            }
            const target = batch.findLast((each) => each._tag === "Through");
            const needsTarget = () =>
              target?._tag === "Through" &&
              !log.hasEvent(target.cursor.id) &&
              cache.more &&
              cache.before !== undefined &&
              byTime(target.cursor, cache.before) < 0;
            if (batch.some((each) => each._tag === "Fill") && cache.gaps.length > 0) {
              const read = yield* Backend.use((client) =>
                Effect.forEach(
                  [...cache.gaps],
                  (gap) =>
                    fillGap((request) => client("ThreadHistory", pageRequest(request)), log, gap).pipe(
                      Effect.as(gap),
                    ),
                  { concurrency: 1 },
                ),
              ).pipe(Effect.option);
              if (Option.isSome(read)) cache.gaps = cache.gaps.filter((gap) => !read.value.includes(gap));
              pageRevision++;
              loadError = Option.isNone(read) ? "Tool activity couldn’t load. Try again." : undefined;
              changed = true;
            }
            const newestLoaded = cache.before;
            if (
              target?._tag === "Through" &&
              needsTarget() &&
              newestLoaded !== undefined &&
              cache.hops >= DEEP_JUMP_PAGES &&
              get.registry.get(drivenRpcVersionAtom) >= STATE_HISTORY_RPC_VERSION
            ) {
              // A deep jump: the stretch up to the target is read as state events, never as tool payloads.
              const jumped = yield* Backend.use((client) =>
                jumpThrough(
                  (request) => client("ThreadHistory", pageRequest(request)),
                  log,
                  target.cursor,
                  newestLoaded,
                ),
              ).pipe(Effect.option);
              pageRevision++;
              cache.hops = 0;
              if (Option.isSome(jumped)) {
                cache.before = jumped.value.before;
                cache.more = jumped.value.more;
                if (byTime(jumped.value.gap.older, jumped.value.gap.newer) < 0)
                  cache.gaps.push(jumped.value.gap);
                loadError = undefined;
                changed = true;
              }
            }
            if (batch.some((each) => each._tag === "Older") || needsTarget()) {
              const read = yield* history(true).pipe(
                Effect.retry({ schedule: Schedule.spaced("1 second"), times: 5 }),
                Effect.option,
              );
              pageRevision++;
              loadError = Option.isNone(read) ? "Earlier messages couldn't load. Try again." : undefined;
              changed = true;
              if (Option.isSome(read)) cache.hops++;
              // Keep the loaded suffix contiguous: each request is bounded and lets queued live
              // events through before the next page. Never fold disconnected navigation pages.
              if (Option.isSome(read) && needsTarget() && target?._tag === "Through")
                loadThrough(target.cursor);
            }
            if (target?._tag === "Through" && !needsTarget()) cache.hops = 0;
            changed =
              log.add(
                batch.flatMap((each) =>
                  each._tag === "Event" && inHistoryWindow(each.event, cache.before, cache.more)
                    ? [each.event]
                    : [],
                ),
              ) || changed;
            return changed ? Option.some(state()) : Option.none();
          }),
        ),
        Stream.filter(Option.isSome),
        Stream.map((read) => read.value),
        resubscribe,
      ),
    );
  }),
);

const sameEvents = (a: ReadonlyArray<AgentEvent>, b: ReadonlyArray<AgentEvent>) =>
  a === b || (a.length === b.length && a.every((event, index) => Equal.equals(event, b[index])));

const relevantTo = (view: ThreadStateView, event: AgentEvent) => {
  switch (view) {
    case "artifacts":
      return isArtifactCandidate(event);
    case "files":
      return event.payload._tag === "FileChanged";
    case "run":
      return (
        event.payload._tag === "TurnCompleted" ||
        event.payload._tag === "UsageReported" ||
        event.payload._tag === "TurnFilesChanged" ||
        event.payload._tag === "TurnFilesReverted"
      );
    case "main":
      return affectsThreadState(event);
  }
};

/** Read side-panel state when its inputs change or the live connection reconnects. */
const threadSideEvents = (view: ThreadStateView) =>
  Atom.family((threadId: ThreadId) =>
    Backend.runtime
      .atom((get) => {
        const log = new ThreadLog();
        const machine = get.once(machineAtom);
        const appendOnly = view === "files" || view === "artifacts";
        let legacy = false;
        let after = 0;
        const read = Backend.use((client) =>
          Effect.gen(function* () {
            const account = AsyncResult.getOrElse(get.registry.get(accountAtom), () => undefined);
            const version =
              machine === undefined
                ? Infinity
                : account?._tag === "SignedIn"
                  ? (account.devices.find((device) => device.id === machine.id)?.rpcVersion ?? 0)
                  : 0;
            legacy = version < 50;
            if (!legacy) return yield* client("ThreadState", { threadId, view });

            // Older machines still send the state inputs from their history.
            if (version < 47) {
              log.add(
                (yield* client("ThreadEvents", { threadId, withoutImages: true })).filter((event) =>
                  relevantTo(view, event),
                ),
              );
            } else {
              for (;;) {
                const page = yield* client("ThreadHistory", { threadId, page: { after, state: true } });
                log.add(page.events.filter((event) => relevantTo(view, event)));
                after = page.after;
                if (!page.more) break;
                yield* Effect.yieldNow;
              }
            }
            return log.state().settled;
          }),
        );
        return Stream.unwrap(
          Effect.map(subscribeLive(get), (live) =>
            Stream.concat(Stream.succeed(subscribed), Stream.fromSubscription(live)).pipe(
              Stream.filter(
                (each) =>
                  each._tag === "Subscribed" ||
                  (each.event.threadId === threadId && relevantTo(view, each.event)),
              ),
              Stream.chunks,
              Stream.mapEffect((batch) =>
                Effect.gen(function* () {
                  const reconnect = batch.some((each) => each._tag === "Subscribed");
                  if (reconnect || (!legacy && !appendOnly)) {
                    const state = yield* read;
                    if (!legacy) {
                      if (!appendOnly) return state;
                      log.add(state);
                    }
                  }
                  log.add(batch.flatMap((each) => (each._tag === "Event" ? [each.event] : [])));
                  return log.state().settled;
                }),
              ),
            ),
          ),
        ).pipe(resubscribe);
      })
      .pipe(Atom.withEquality(sameRead(sameEvents)), Atom.setIdleTTL(CLOSED_THREAD_TTL)),
  );

const mainEventsAtom = threadSideEvents("main");
export const artifactEventsAtom = threadSideEvents("artifacts");
export const runEventsAtom = threadSideEvents("run");

/**
 * What a thread's agents' summaries (`toAgentSummaries`) read of its events: its
 * messages, usage, todo lists, models, failures and requests of the user. Tool calls, most of a
 * working thread's events, change none of it.
 */
const SUMMARY_TAGS: ReadonlySet<EventPayload["_tag"]> = new Set([
  "MessageCompleted",
  "UsageReported",
  "ContextReported",
  "ContextCompacted",
  "ConversationRewound",
  "TodosUpdated",
  "BackgroundTasksChanged",
  "SessionStarted",
  "ModelChanged",
  "LeadHandedOff",
  "AgentError",
  "PermissionRequested",
  "PermissionResolved",
  "SpawnApprovalRequested",
  "SpawnApprovalResolved",
  "QuestionAsked",
  "QuestionResolved",
]);

const QUEUE_TAGS: ReadonlySet<EventPayload["_tag"]> = new Set([
  "MessageQueued",
  "MessageHeld",
  "TurnInput",
  "TurnCompleted",
  "MessageWithdrawn",
  "ConversationRewound",
]);

/** A thread's events of the kinds in `tags`, changing only when one of them arrives. */
const eventsOfKinds = (threadId: ThreadId, tags: ReadonlySet<EventPayload["_tag"]>) =>
  Atom.make((get) =>
    AsyncResult.map(get(mainEventsAtom(threadId)), (events) =>
      events.filter((event) => tags.has(event.payload._tag)),
    ),
  ).pipe(Atom.withEquality(sameRead(sameEvents)));

/**
 * A thread's events its agents' summaries are worked out from. The window reads these
 * rather than every event: rendering it again took tens of milliseconds, and an agent at work makes
 * several events a second, most of them tool calls that change nothing it shows.
 */
export const summaryEventsAtom = Atom.family((threadId: ThreadId) => eventsOfKinds(threadId, SUMMARY_TAGS));

/** The files a thread's agents changed, as they report them, for the files panel. */
export const fileChangesAtom = threadSideEvents("files");

/** The events a lead's queued messages are worked out from, for the ones waiting in the message box. */
export const queueEventsAtom = Atom.family((threadId: ThreadId) => eventsOfKinds(threadId, QUEUE_TAGS));

export const createThread = Backend.mutation("CreateThread");
export const forkThread = Backend.mutation("ForkThread");
export const previewForkThread = Backend.mutation("PreviewForkThread");
export const sendMessage = Backend.mutation("SendMessage");
export const editMessage = Backend.mutation("EditMessage");
export const previewRestore = Backend.mutation("PreviewRestore");
export const restoreBefore = Backend.mutation("RestoreBefore");
export const switchModel = Backend.mutation("SwitchModel");
export const handOffLead = Backend.mutation("HandOffLead");
export const compactAgent = Backend.mutation("CompactAgent");
export const stopBackgroundTask = Backend.mutation("StopBackgroundTask");
export const askSideQuestion = Backend.mutation("AskSideQuestion");
export const suggestFollowup = Backend.mutation("SuggestFollowup");

/** Only the live feed can trigger autocomplete. Reading history or catching up after a disconnect cannot. */
const followupBoundaries = new Set<EventPayload["_tag"]>([
  "TurnCompleted",
  "TurnInput",
  "MessageQueued",
  "MessageHeld",
  "AgentError",
  "ConversationRewound",
  "ModelChanged",
  "LeadHandedOff",
  "WorkspaceMoved",
]);
export const followupEventAtom = Atom.family((lead: AgentId) =>
  Backend.runtime.atom((get) =>
    Stream.unwrap(
      Effect.map(subscribeLive(get), (subscription) =>
        Stream.fromSubscription(subscription).pipe(
          Stream.filter(
            (item) =>
              item._tag === "Subscribed" ||
              (item.event.agentId === lead && followupBoundaries.has(item.event.payload._tag)),
          ),
          Stream.map((item) =>
            item._tag === "Event" &&
            item.event.payload._tag === "TurnCompleted" &&
            item.event.payload.stopReason === "completed"
              ? item.event.sequence
              : null,
          ),
        ),
      ),
    ),
  ),
);
export const respondToPermission = Backend.mutation("RespondToPermission");
export const answerQuestion = Backend.mutation("AnswerQuestion");
export const resolveSpawnApproval = Backend.mutation("ResolveSpawnApproval");
/**
 * Interrupting or stopping an agent reads the thread list again once done, so pressing stop on an
 * agent the window still shows working, though it isn't, puts that right.
 */
export const interruptAgent = Backend.runtime.fn<{ readonly payload: { readonly agentId: AgentId } }>()(
  ({ payload }, get) =>
    Backend.use((client) => client("InterruptAgent", payload)).pipe(
      Effect.ensuring(Effect.sync(() => get.refresh(threadsAtom))),
    ),
);
export const steerAgent = Backend.mutation("SteerAgent");
export const withdrawMessage = Backend.mutation("WithdrawMessage");
export const stopAgent = Backend.runtime.fn<{ readonly payload: { readonly agentId: AgentId } }>()(
  ({ payload }, get) =>
    Backend.use((client) => client("StopAgent", payload)).pipe(
      Effect.ensuring(Effect.sync(() => get.refresh(threadsAtom))),
    ),
);
export const stopThread = Backend.runtime.fn<{ readonly payload: { readonly threadId: ThreadId } }>()(
  ({ payload }, get) =>
    Backend.use((client) => client("StopThread", payload)).pipe(
      Effect.ensuring(Effect.sync(() => get.refresh(threadsAtom))),
    ),
);
export const renameThread = Backend.mutation("RenameThread");
export const setThreadArchived = Backend.mutation("SetThreadArchived");
export const setThreadLater = Backend.mutation("SetThreadLater");
export const continueThread = Backend.mutation("ContinueThread");
export const setThreadOnLimit = Backend.mutation("SetThreadOnLimit");
export const deleteThread = Backend.mutation("DeleteThread");
export const updateSettings = Backend.mutation("UpdateSettings");
export const removeEffortRouterKey = Backend.mutation("RemoveEffortRouterKey");
// The key is only ever typed into the desktop app of the computer whose agents use it.
export const saveEffortRouterKey = LocalBackend.mutation("SaveEffortRouterKey");
// This computer's account is managed only from its own backend, whatever the window drives.
export const signIn = LocalBackend.mutation("SignIn");
export const cancelSignIn = LocalBackend.mutation("CancelSignIn");
export const signOut = LocalBackend.mutation("SignOut");
export const renameDevice = LocalBackend.mutation("RenameDevice");
export const removeDevice = LocalBackend.mutation("RemoveDevice");
export const disconnectAssistant = LocalBackend.mutation("DisconnectAssistant");
export const markThreadsRead = LocalBackend.mutation("MarkThreadsRead");
export const saveDrafts = LocalBackend.mutation("SaveDrafts");
export const saveTasks = LocalBackend.mutation("SaveTasks");

/**
 * What agents say the user's tasks list gained and lost, each batch as an event's
 * `UserTasksChanged` told it, kept while the window's tasks so a coalesced render loses none.
 * `TaskSync` merges them into the window's, newest-wins, and pushes its list back for the agents'
 * tools to read.
 */
export const agentTaskEventsAtom = Backend.runtime
  .atom((get) =>
    Stream.unwrap(
      Effect.map(subscribeLive(get), (live) =>
        Stream.fromSubscription(live).pipe(
          Stream.flatMap((live) =>
            live._tag === "Event" && live.event.payload._tag === "UserTasksChanged"
              ? Stream.make(live.event.payload.tasks)
              : Stream.empty,
          ),
          Stream.scan(
            (): ReadonlyMap<string, TaskEntry> => new Map(),
            (kept, batch) => {
              const next = new Map(kept);
              for (const entry of batch) next.set(entry.id, entry);
              return next;
            },
          ),
        ),
      ),
    ),
  )
  .pipe(Atom.keepAlive);

/** What this window holds of the user's tasks, as the machine's agents' tools see them. */
export const syncUserTasks = Backend.mutation("SyncUserTasks");
// Push notifications: what the window shows, and a browser's subscription.
export const reportPresence = LocalBackend.mutation("ReportPresence");
export const subscribePush = LocalBackend.mutation("SubscribePush");
export const unsubscribePush = LocalBackend.mutation("UnsubscribePush");
