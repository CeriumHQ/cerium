import {
  isStreamDelta,
  ModelInfo,
  type AccountThreads,
  type AgentEvent,
  type AgentId,
  type DeviceId,
  type ProviderId,
  type ThreadId,
} from "@cerium/protocol";
import { Effect, Option, PubSub, Schedule, Schema, Stream } from "effect";
import { Atom } from "effect/reactivity";

import { remember, stored } from "../lib/storage.ts";
import { Backend, BackendUnreachable, connectionAtom, LocalBackend } from "./client.ts";
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
 * shares; events of kinds this version doesn't know are skipped (§14.1). It subscribes again when the
 * connection comes back, and marks each subscription once its request is on its way: what happened
 * while the connection was down never arrives, so readers read again what they hold.
 */
const liveFeedAtom = Backend.runtime
  .atom(
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
        Effect.andThen(Effect.sleep("1 second")),
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
 * last list it read.
 */
export const threadsAtom = Backend.runtime.atom((get) => {
  get.mount(liveFeedAtom);
  if (get(connectionAtom) !== "connected") {
    return Stream.fail(new BackendUnreachable({ message: "The machine isn't connected." }));
  }
  const listThreads = Backend.use((client) => client("ListThreads", undefined));
  return Stream.unwrap(
    Effect.map(subscribeLive(get), (live) =>
      Stream.concat(
        Stream.succeed(subscribed),
        Stream.fromSubscription(live).pipe(Stream.filter(isActivity)),
      ),
    ),
  ).pipe(
    Stream.buffer({ capacity: 1, strategy: "sliding" }),
    Stream.mapEffect(() => listThreads),
    resubscribe,
  );
});

export const harnessesAtom = Backend.runtime.atom((get) => {
  get(connectionAtom);
  return Backend.use((client) => client("HarnessStatuses", undefined));
});

const providers: ReadonlyArray<ProviderId> = ["claude", "codex", "muse", "cursor"];
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
    get(connectionAtom);
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
 * This machine's Cerium account (docs/architecture.md §14): signed out, signing in, or signed in with
 * the account's devices. Picked back up after a reconnect.
 */
export const accountAtom = LocalBackend.runtime.atom(
  Stream.unwrap(LocalBackend.use((client) => Effect.succeed(client("WatchAccount", undefined)))).pipe(
    resubscribe,
  ),
);

/**
 * Every thread of the account, on whichever machine (§14.9), and what was seen of them on any
 * device. Empty while signed out.
 */
export const accountThreadsAtom = LocalBackend.runtime.atom(
  Stream.unwrap(LocalBackend.use((client) => Effect.succeed(client("WatchAccountThreads", undefined)))).pipe(
    resubscribe,
  ),
  { initialValue: { threads: [], read: [] } satisfies AccountThreads },
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
  get(connectionAtom);
  return Backend.use((client) => client("Settings", undefined));
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
      const history = Backend.use((client) => client("ThreadEvents", { threadId })).pipe(
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

export const createThread = Backend.mutation("CreateThread");
export const sendMessage = Backend.mutation("SendMessage");
export const respondToPermission = Backend.mutation("RespondToPermission");
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
export const stopAgent = Backend.runtime.fn<{ readonly payload: { readonly agentId: AgentId } }>()(
  ({ payload }, get) =>
    Backend.use((client) => client("StopAgent", payload)).pipe(
      Effect.ensuring(Effect.sync(() => get.refresh(threadsAtom))),
    ),
);
export const renameThread = Backend.mutation("RenameThread");
export const setThreadArchived = Backend.mutation("SetThreadArchived");
export const deleteThread = Backend.mutation("DeleteThread");
export const updateSettings = Backend.mutation("UpdateSettings");
// This computer's account is managed only from its own backend, whatever the window drives.
export const signIn = LocalBackend.mutation("SignIn");
export const cancelSignIn = LocalBackend.mutation("CancelSignIn");
export const signOut = LocalBackend.mutation("SignOut");
export const approveDevice = LocalBackend.mutation("ApproveDevice");
export const renameDevice = LocalBackend.mutation("RenameDevice");
export const removeDevice = LocalBackend.mutation("RemoveDevice");
export const markThreadsRead = LocalBackend.mutation("MarkThreadsRead");
// Push notifications (docs/architecture.md §14.11): what the window shows, and a browser's subscription.
export const reportPresence = LocalBackend.mutation("ReportPresence");
export const subscribePush = LocalBackend.mutation("SubscribePush");
export const unsubscribePush = LocalBackend.mutation("UnsubscribePush");
