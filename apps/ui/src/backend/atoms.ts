import {
  ModelInfo,
  type AccountThreads,
  type AgentEvent,
  type DeviceId,
  type ProviderId,
  type ThreadId,
} from "@cerium/protocol";
import { Effect, Option, Schedule, Schema, Stream } from "effect";
import { Atom } from "effect/reactivity";

import { remember, stored } from "../lib/storage.ts";
import { Backend, connectionAtom, LocalBackend } from "./client.ts";
import { machineAtom, machineKey, type DrivenMachine } from "./machine.ts";

/** Live feeds end when the connection drops; this picks them back up once it returns. */
const resubscribe = Stream.retry(Schedule.spaced("1 second"));

const liveEvents = Stream.unwrap(Backend.use((client) => Effect.succeed(client("WatchEvents", undefined))));

const isDelta = (event: AgentEvent) =>
  event.payload._tag === "MessageDelta" || event.payload._tag === "ReasoningDelta";

/** Ticks whenever something other than streamed text happens; lists re-fetch on it. */
export const activityAtom = Backend.runtime.atom(
  liveEvents.pipe(
    resubscribe,
    Stream.filter((event) => !isDelta(event)),
    Stream.scan(
      () => 0,
      (count: number) => count + 1,
    ),
  ),
);

/** Every thread with its agents and whether it waits on the user. Refreshes as agents work. */
export const threadsAtom = Backend.runtime.atom((get) => {
  get(connectionAtom);
  get(activityAtom);
  return Backend.use((client) => client("ListThreads", undefined));
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

type EventSource =
  | { readonly _tag: "History"; readonly events: ReadonlyArray<AgentEvent> }
  | { readonly _tag: "Live"; readonly event: AgentEvent };

const byTime = (a: AgentEvent, b: AgentEvent) => a.at - b.at || a.sequence - b.sequence;

/**
 * A thread's events: persisted history merged with live events, including streamed text. History
 * and the live feed start together and are de-duplicated by event id, so nothing falls in between,
 * including across a reconnect, which fetches the history again.
 */
export const threadEventsAtom = Atom.family((threadId: ThreadId) =>
  Backend.runtime.atom(
    Stream.unwrap(
      Backend.use((client) =>
        Effect.succeed(
          Stream.merge(
            client("WatchEvents", undefined).pipe(
              Stream.filter((event) => event.threadId === threadId),
              Stream.map((event): EventSource => ({ _tag: "Live", event })),
            ),
            Stream.fromEffect(
              client("ThreadEvents", { threadId }).pipe(
                Effect.map((events): EventSource => ({ _tag: "History", events })),
              ),
            ),
          ),
        ),
      ),
    ).pipe(
      resubscribe,
      Stream.scan(
        () => new Map<string, AgentEvent>(),
        (seen: ReadonlyMap<string, AgentEvent>, source: EventSource) => {
          const next = new Map(seen);
          for (const event of source._tag === "History" ? source.events : [source.event])
            next.set(event.id, event);
          return next;
        },
      ),
      Stream.map((seen) => [...seen.values()].sort(byTime)),
    ),
  ),
);

export const createThread = Backend.mutation("CreateThread");
export const sendMessage = Backend.mutation("SendMessage");
export const respondToPermission = Backend.mutation("RespondToPermission");
export const interruptAgent = Backend.mutation("InterruptAgent");
export const stopAgent = Backend.mutation("StopAgent");
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
