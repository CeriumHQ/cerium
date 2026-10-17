import { ModelInfo, type AgentEvent, type ProviderId, type ThreadId } from "@cerium/protocol";
import { Effect, Option, Schedule, Schema, Stream } from "effect";
import { Atom } from "effect/reactivity";

import { remember, stored } from "../lib/storage.ts";
import { Backend, connectionAtom } from "./client.ts";

/** Live feeds end when the connection drops; this picks them back up once it returns. */
const resubscribe = Stream.retry(Schedule.spaced("1 second"));

const liveEvents = Stream.unwrap(Backend.use((client) => Effect.succeed(client("WatchEvents", undefined))));

const isDelta = (event: AgentEvent) =>
  event.payload._tag === "MessageDelta" || event.payload._tag === "ReasoningDelta";

/** Ticks whenever something other than streamed text happens; lists re-fetch on it. */
const activityAtom = Backend.runtime.atom(
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

/** The last lists the harnesses gave, so the model pickers fill in before they answer again. */
const cachedModels = (): ReadonlyArray<ModelInfo> =>
  Schema.decodeUnknownOption(CachedModels)(stored(MODELS_KEY)).pipe(Option.getOrElse(() => []));

/**
 * Every harness's models, in provider order. Each provider's list replaces its cached one as soon as
 * that harness answers; one that can't be used offers none. Re-read after a reconnect.
 */
export const modelsAtom = Backend.runtime.atom(
  (get) => {
    get(connectionAtom);
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
      Stream.scan(cachedModels, (current, answer) => {
        const next = providers.flatMap((provider) =>
          provider === answer.provider
            ? answer.models
            : current.filter((model) => model.provider === provider),
        );
        remember(MODELS_KEY, Schema.encodeSync(CachedModels)(next));
        return next;
      }),
    );
  },
  { initialValue: cachedModels() },
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
export const updateSettings = Backend.mutation("UpdateSettings");
