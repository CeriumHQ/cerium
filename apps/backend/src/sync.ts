import { Account } from "@cerium/account";
import { Orchestrator } from "@cerium/orchestrator";
import {
  isStreamDelta,
  MAX_SYNC_BATCH_BYTES,
  UiEvent,
  withoutImages,
  type AgentEvent,
  type ThreadId,
} from "@cerium/protocol";
import { Store } from "@cerium/store";
import { Deferred, Effect, Layer, PubSub, Queue, Schema, Stream } from "effect";

// Synced threads. While signed in, this machine keeps the cloud copy of
// its threads current: each thread's overview when it changes, and its events but streamed text, in
// batches from where the cloud's copy ends. The account's threads as the relay tells them, and reading
// other machines', are `CloudThreads` in @cerium/account.

/** How often overviews are compared even without new events: renames and archives make none. */
const SWEEP_EVERY = "15 seconds";
/** How long after an event the next upload waits, so a busy turn goes up in a few batches. */
const SETTLE_FOR = "1 second";
/** How long the relay gets to accept a batch before the upload stops until the next round. */
const ACCEPT_WITHIN = "20 seconds";
/** Events read from the store at a time. */
const PAGE = 200;
/** Strings longer than this are cut in the cloud copy of an event too big for one batch. */
const LONG_STRING = 50_000;

const encodeEvent = Schema.encodeSync(UiEvent);

/**
 * An event's cloud copy: as the UI sees it without the images of tool outputs, which stay on this
 * machine, and with very long strings cut when it's too big to store.
 */
export const cloudEvent = (event: AgentEvent): UiEvent => {
  const ui = encodeEvent(withoutImages(event)) as UiEvent;
  if (JSON.stringify(ui).length <= MAX_SYNC_BATCH_BYTES) return ui;
  const cut = (value: unknown): unknown =>
    typeof value === "string" && value.length > LONG_STRING
      ? `${value.slice(0, LONG_STRING)}\n… (shortened in the cloud copy)`
      : Array.isArray(value)
        ? value.map(cut)
        : typeof value === "object" && value !== null
          ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, cut(inner)]))
          : value;
  return { ...ui, payload: cut(ui.payload) as UiEvent["payload"] };
};

/** Events split into batches the relay can store, each under `MAX_SYNC_BATCH_BYTES`. */
export const batches = (events: ReadonlyArray<UiEvent>): Array<Array<UiEvent>> => {
  const out: Array<Array<UiEvent>> = [];
  let current: Array<UiEvent> = [];
  let size = 2;
  for (const event of events) {
    const bytes = JSON.stringify(event).length + 1;
    if (current.length > 0 && size + bytes > MAX_SYNC_BATCH_BYTES) {
      out.push(current);
      current = [];
      size = 2;
    }
    current.push(event);
    size += bytes;
  }
  if (current.length > 0) out.push(current);
  return out;
};

/**
 * Keeps this machine's threads' cloud copy current while it's signed in. Requires `Account`,
 * `Orchestrator` and `Store`.
 */
export const CloudCopy = Layer.effectDiscard(
  Effect.gen(function* () {
    const account = yield* Account;
    const orchestrator = yield* Orchestrator;
    const store = yield* Store;
    const kick = yield* Queue.sliding<void>(1);

    /** How many events of each of this machine's threads the cloud has; none until it says. */
    let cursors: Map<string, number> | undefined;
    /** The overview last sent of each thread, as JSON, to send only what changed. */
    const sent = new Map<string, string>();
    const accepted = new Map<string, Deferred.Deferred<number>>();

    const overviews = orchestrator.threadOverviews;

    /** Sends a thread's events from where the cloud's copy ends, a batch at a time. */
    const upload = Effect.fn("CloudCopy.upload")(function* (threadId: ThreadId, from: number) {
      let start = from;
      while (true) {
        const page = yield* store.listSyncedEvents(threadId, start, PAGE);
        for (const batch of batches(page.map(cloudEvent))) {
          const answer = yield* Deferred.make<number>();
          accepted.set(threadId, answer);
          yield* account.send({ _tag: "SyncEvents", threadId, start, events: batch });
          const count = yield* Deferred.await(answer).pipe(
            Effect.timeoutOrElse({ duration: ACCEPT_WITHIN, orElse: () => Effect.succeed(-1) }),
          );
          accepted.delete(threadId);
          // No answer, or the relay has fewer than it was sent (a gap): try again next round.
          if (count < start + batch.length) return;
          start = count;
        }
        // A page short of full was the last; asking again would only read an empty one.
        if (page.length < PAGE) return;
      }
    });

    /** One round: changed overviews, threads gone from here, and events the cloud doesn't have. */
    const round = Effect.gen(function* () {
      const known = cursors;
      if (known === undefined) return;
      const local = yield* overviews;
      const changed = local.flatMap((overview) => {
        const json = JSON.stringify(overview);
        return sent.get(overview.thread.id) === json ? [] : [{ overview, json }];
      });
      for (let index = 0; index < changed.length; index += 50) {
        yield* account.send({
          _tag: "SyncThreads",
          threads: changed.slice(index, index + 50).map(({ overview }) => overview),
        });
      }
      for (const { overview, json } of changed) sent.set(overview.thread.id, json);

      const here = new Set(local.map((overview) => overview.thread.id as string));
      const gone = [...new Set([...known.keys(), ...sent.keys()])].filter(
        (id) => !here.has(id),
      ) as Array<ThreadId>;
      if (gone.length > 0) {
        yield* account.send({ _tag: "SyncRemoved", threadIds: gone });
        for (const id of gone) {
          known.delete(id);
          sent.delete(id);
        }
      }

      const counts = yield* store.countSyncedEvents;
      for (const overview of local) {
        const id = overview.thread.id;
        if ((counts.get(id) ?? 0) > (known.get(id) ?? 0)) yield* upload(id, known.get(id) ?? 0);
      }
    }).pipe(Effect.ignore);

    // What the relay says about uploads: where the cloud's copy ends, and what it took.
    yield* Effect.gen(function* () {
      const events = yield* account.relayEvents;
      while (true) {
        const event = yield* PubSub.take(events);
        if (event._tag === "SyncCursors") {
          cursors = new Map(Object.entries(event.threads));
          sent.clear();
          yield* Queue.offer(kick, undefined);
        } else if (event._tag === "SyncAccepted") {
          cursors?.set(event.threadId, event.count);
          const answer = accepted.get(event.threadId);
          if (answer !== undefined) yield* Deferred.succeed(answer, event.count);
        } else if (event._tag === "RelayLost") {
          cursors = undefined;
          for (const answer of accepted.values()) yield* Deferred.succeed(answer, -1);
        }
      }
    }).pipe(Effect.scoped, Effect.forkScoped);

    // New events (not streamed text) start a round soon; a sweep catches renames and archives.
    yield* orchestrator.events.pipe(
      Stream.filter((event) => !isStreamDelta(event.payload._tag)),
      Stream.runForEach(() => Queue.offer(kick, undefined)),
      Effect.forkScoped,
    );
    yield* Queue.offer(kick, undefined).pipe(Effect.delay(SWEEP_EVERY), Effect.forever, Effect.forkScoped);
    yield* Queue.take(kick).pipe(
      Effect.andThen(Effect.sleep(SETTLE_FOR)),
      Effect.andThen(round),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
