import {
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
  type PastSession,
  type ProviderId,
  type TaskEntry,
  type ThreadId,
  type ThreadNotification,
} from "@cerium/protocol";
import { Clock, Effect, Equal, Option, PubSub, Schedule, Schema, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { remember, stored } from "../lib/storage.ts";
import { Backend, BackendUnreachable, connectionAtom, connectionEpochAtom, LocalBackend } from "./client.ts";
import { machineAtom, machineKey, type DrivenMachine } from "./machine.ts";
import { byTime, ThreadLog } from "./threadLog.ts";

/** Live feeds end when the connection drops; this picks them back up once it returns. */
const resubscribe = Stream.retry(Schedule.spaced("1 second"));

/** What the window's live feed carries: each event, and a mark each time it subscribes again. */
type Live = { readonly _tag: "Event"; readonly event: AgentEvent } | { readonly _tag: "Subscribed" };

const subscribed: Live = { _tag: "Subscribed" };

/**
 * How many events the live subscription holds before the socket waits for the window to take them.
 * The socket reads every answer in turn, so a subscription that makes it wait holds up all the
 * others: the thread list, the open thread and every call the window makes.
 */
const LIVE_BUFFER = 4096;

/**
 * The driven machine's live events, streamed text included, on one subscription the whole window
 * shares; events of kinds this version doesn't know are skipped. It subscribes again when the
 * connection comes back, and marks each subscription once its request is on its way: what happened
 * while the connection was down never arrives, so readers read again what they hold. A line that's
 * coming back is subscribed to again at once, since the request waits for it.
 */
const liveFeedAtom = Backend.runtime
  .atom(({ registry }) =>
    Effect.gen(function* () {
      const feed = yield* PubSub.unbounded<Live>();
      const subscribe = Effect.gen(function* () {
        const client = yield* Backend;
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
            registry.get(connectionAtom) === "reconnecting" ? Effect.void : Effect.sleep("1 second"),
          ),
        ),
        Effect.forever,
        Effect.forkScoped,
      );
      return feed;
    }),
  )
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
 * Every thread with its agents and whether it waits on the user. Read once connected, then again
 * after every change but streamed text and each time the live feed subscribes again. One read runs
 * at a time and changes during it make one more after it, so a busy machine can't keep cancelling
 * reads, and the list always ends on the latest state. While disconnected it fails, keeping the
 * last list it read; while the line comes back it stays as it was, then reads again. A read that
 * finds the list as it was (most events, a tool call say, change no thread's overview) wakes
 * nothing: re-rendering the inbox's rows for each took 55 ms.
 */
export const threadsAtom = Backend.runtime
  .atom((get) => {
    get.mount(liveFeedAtom);
    get(connectionEpochAtom);
    const connection = get.once(connectionAtom);
    if (connection === "connecting" || connection === "unreachable") {
      return Stream.fail(new BackendUnreachable({ message: "The machine isn't connected." }));
    }
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
      Stream.buffer({ capacity: 1, strategy: "sliding" }),
      Stream.mapEffect(() => read),
      resubscribe,
    );
  })
  .pipe(Atom.withEquality(sameRead(Equal.equals)));

export const harnessesAtom = Backend.runtime.atom((get) => {
  get(connectionEpochAtom);
  return Backend.use((client) => client("HarnessStatuses", undefined));
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
export const cloudEventsAtom = Atom.family((key: string) => {
  const split = key.indexOf(":");
  const machine = key.slice(0, split) as DeviceId;
  const threadId = key.slice(split + 1) as ThreadId;
  return LocalBackend.runtime.atom(
    LocalBackend.use((client) => client("CloudThreadEvents", { machine, threadId })).pipe(
      Effect.map((events): ReadonlyArray<AgentEvent> => [...events].sort(byTime)),
    ),
  );
});

/**
 * Whether this computer's own agents are working while the window drives another machine; the
 * shell keeps this computer awake for them. Undefined while the window drives this computer, whose
 * threads say so already.
 */
export const localWorkingAtom = LocalBackend.runtime.atom((get) => {
  if (get(machineAtom) === undefined) return Stream.succeed<boolean | undefined>(undefined);
  return Stream.unwrap(LocalBackend.use((client) => Effect.succeed(client("WatchWorking", undefined)))).pipe(
    resubscribe,
  );
});

/** The user's settings the backend applies, re-read after a reconnect. */
export const settingsAtom = Backend.runtime.atom((get) => {
  get(connectionEpochAtom);
  return Backend.use((client) => client("Settings", undefined));
});

/**
 * Whether the driven machine has an OpenRouter key for the effort router, and what its decisions
 * cost. Re-read after a reconnect; a machine too old for the router fails it.
 */
export const effortRouterStatusAtom = Backend.runtime.atom((get) => {
  get(connectionEpochAtom);
  return Backend.use((client) => client("EffortRouterStatus", undefined));
});

/** How long a thread's events are kept after it closes, so going back to it shows it at once. */
const CLOSED_THREAD_TTL = "5 minutes";

/**
 * A thread's events: its history merged with live events, streamed text included. History is read
 * once subscribed to the live feed and again each time the feed subscribes again, so nothing falls
 * in between, even across a reconnect. Events are taken a batch at a time, which is what keeps a
 * fast reply in a long thread from outrunning the window.
 */
export const threadEventsAtom = Atom.family((threadId: ThreadId) =>
  Backend.runtime
    .atom((get) => {
      // Screenshots are most of a long thread's bytes: each is read when the transcript shows it.
      const history = Backend.use((client) =>
        client("ThreadEvents", { threadId, withoutImages: true, streamed: true }),
      ).pipe(
        Effect.retry({ schedule: Schedule.spaced("1 second"), times: 5 }),
        // What the window holds stays; the next subscription reads again.
        Effect.option,
      );
      return Stream.unwrap(
        Effect.map(subscribeLive(get), (live) => {
          const log = new ThreadLog();
          return Stream.concat(Stream.succeed(subscribed), Stream.fromSubscription(live)).pipe(
            Stream.chunks,
            Stream.mapEffect((batch) =>
              Effect.gen(function* () {
                let changed = log.add(
                  batch.flatMap((each) =>
                    each._tag === "Event" && each.event.threadId === threadId ? [each.event] : [],
                  ),
                );
                if (batch.some((each) => each._tag === "Subscribed")) {
                  const read = yield* history;
                  // Shown once read, even when empty, so a new thread doesn't wait for its first event.
                  changed = Option.isSome(read) ? log.add(read.value) || true : changed;
                }
                return changed ? Option.some(log.snapshot()) : Option.none();
              }),
            ),
            Stream.filter(Option.isSome),
            Stream.map((events) => events.value),
          );
        }),
      );
    })
    .pipe(Atom.setIdleTTL(CLOSED_THREAD_TTL)),
);

const sameEvents = (a: ReadonlyArray<AgentEvent>, b: ReadonlyArray<AgentEvent>) =>
  a.length === b.length && a.every((event, index) => event === b[index]);

/**
 * A thread's events but streamed text, for what the window works out around the conversation (its
 * agents, artifacts and changed files), none of which streamed text changes. It changes only when
 * another event arrives, so the window around the transcript doesn't render again for every
 * streamed word, which took 60 ms in a window listing 140 threads.
 */
export const settledEventsAtom = Atom.family((threadId: ThreadId) =>
  Atom.make((get) =>
    AsyncResult.map(get(threadEventsAtom(threadId)), (events) =>
      events.filter((event) => !isStreamDelta(event.payload._tag)),
    ),
  ).pipe(Atom.withEquality(sameRead(sameEvents))),
);

/**
 * What a thread's agents' summaries (`toAgentSummaries`) and its artifacts read of its events: its
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

const FILE_TAGS: ReadonlySet<EventPayload["_tag"]> = new Set(["FileChanged"]);

const QUEUE_TAGS: ReadonlySet<EventPayload["_tag"]> = new Set([
  "MessageQueued",
  "TurnInput",
  "TurnCompleted",
  "MessageWithdrawn",
  "ConversationRewound",
]);

/** A thread's events of the kinds in `tags`, changing only when one of them arrives. */
const eventsOfKinds = (threadId: ThreadId, tags: ReadonlySet<EventPayload["_tag"]>) =>
  Atom.make((get) =>
    AsyncResult.map(get(settledEventsAtom(threadId)), (events) =>
      events.filter((event) => tags.has(event.payload._tag)),
    ),
  ).pipe(Atom.withEquality(sameRead(sameEvents)));

/**
 * A thread's events its agents' summaries and artifacts are worked out from. The window reads these
 * rather than every event: rendering it again took tens of milliseconds, and an agent at work makes
 * several events a second, most of them tool calls that change nothing it shows.
 */
export const summaryEventsAtom = Atom.family((threadId: ThreadId) => eventsOfKinds(threadId, SUMMARY_TAGS));

/** The files a thread's agents changed, as they report them, for the files panel. */
export const fileChangesAtom = Atom.family((threadId: ThreadId) => eventsOfKinds(threadId, FILE_TAGS));

/** The events a lead's queued messages are worked out from, for the ones waiting in the message box. */
export const queueEventsAtom = Atom.family((threadId: ThreadId) => eventsOfKinds(threadId, QUEUE_TAGS));

export const createThread = Backend.mutation("CreateThread");
export const sendMessage = Backend.mutation("SendMessage");
export const editMessage = Backend.mutation("EditMessage");
export const previewRestore = Backend.mutation("PreviewRestore");
export const restoreBefore = Backend.mutation("RestoreBefore");
export const switchModel = Backend.mutation("SwitchModel");
export const handOffLead = Backend.mutation("HandOffLead");
export const compactAgent = Backend.mutation("CompactAgent");
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
