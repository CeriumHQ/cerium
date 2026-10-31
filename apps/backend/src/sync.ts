import { Account } from "@cerium/account";
import { Orchestrator } from "@cerium/orchestrator";
import {
  isStreamDelta,
  MAX_SYNC_BATCH_BYTES,
  UiEvent,
  withoutImages,
  type AgentEvent,
  type ThreadId,
  type ThreadOverview,
} from "@cerium/protocol";
import { Store } from "@cerium/store";
import { Clock, Deferred, Effect, Layer, PubSub, Queue, Schema, Stream } from "effect";

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
/**
 * Threads uploading at once. Each waits on the relay's answer to every batch, most of it the trip
 * there and back, so a few at once catch up several times faster.
 */
const UPLOADS = 4;
/**
 * How long a round goes on starting batches. Catching up on a long history takes many rounds, each
 * starting from the threads active last, so a new message goes up within a few seconds meanwhile.
 */
const ROUND_BUDGET = 2_000;
/**
 * How long strings may stay in the cloud copy of an event too big for one batch, tried in turn until
 * it fits.
 */
const LONG_STRINGS = [50_000, 4_000, 256];
/** The most one event may take, so it fits a batch on its own (`batches` adds its brackets). */
const EVENT_BYTES = MAX_SYNC_BATCH_BYTES - 2;

const encodeEvent = Schema.encodeSync(UiEvent);

/** What a value takes on the wire: UTF-8 bytes of its JSON, not UTF-16 code units. */
const wireBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * An event's cloud copy: as the UI sees it without the images of tool outputs, which stay on this
 * machine, and with long strings cut when it's too big to store. One that still doesn't fit, all its
 * strings short, is told in its place.
 */
export const cloudEvent = (event: AgentEvent): UiEvent => {
  const ui = encodeEvent(withoutImages(event)) as UiEvent;
  if (wireBytes(ui) <= EVENT_BYTES) return ui;
  for (const limit of LONG_STRINGS) {
    const cut = (value: unknown): unknown =>
      typeof value === "string" && value.length > limit
        ? `${value.slice(0, limit)}\n… (shortened in the cloud copy)`
        : Array.isArray(value)
          ? value.map(cut)
          : typeof value === "object" && value !== null
            ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, cut(inner)]))
            : value;
    const shortened = { ...ui, payload: cut(ui.payload) as UiEvent["payload"] };
    if (wireBytes(shortened) <= EVENT_BYTES) return shortened;
  }
  return {
    ...ui,
    payload: {
      _tag: "AgentError",
      kind: "unknown",
      message: `A ${ui.payload._tag} event here was too large for the cloud copy; it is on the machine that ran the thread.`,
      retryable: false,
    },
  };
};

/** When something last happened in a thread, as its overview says: the thread or one of its agents changed. */
export const lastActive = (overview: ThreadOverview): number =>
  Math.max(overview.thread.updatedAt, ...overview.agents.map((agent) => agent.updatedAt));

/** Events split into batches the relay can store, each under `MAX_SYNC_BATCH_BYTES`. */
export const batches = (events: ReadonlyArray<UiEvent>): Array<Array<UiEvent>> => {
  const out: Array<Array<UiEvent>> = [];
  let current: Array<UiEvent> = [];
  let size = 2;
  for (const event of events) {
    const bytes = wireBytes(event) + 1;
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
    /** Only acknowledged pages advance these anchors; a reconnect translates fresh relay counts. */
    const positions = new Map<string, { readonly count: number; readonly after: string | undefined }>();

    const overviews = orchestrator.threadOverviews;

    /**
     * Sends a thread's events from where the cloud's copy ends, a batch at a time, starting none past
     * `deadline`. Resolves whether it stopped for the deadline with events left to send.
     */
    const upload = Effect.fn("CloudCopy.upload")(function* (
      threadId: ThreadId,
      from: number,
      deadline: number,
      connection: ReadonlyMap<string, number>,
    ) {
      let start = from;
      let position = positions.get(threadId);
      if (position?.count !== from) {
        position = { count: from, after: yield* store.syncedEventCursor(threadId, from) };
        positions.set(threadId, position);
      }
      while (true) {
        if (cursors !== connection) return false;
        if ((yield* Clock.currentTimeMillis) >= deadline) return true;
        const page: ReadonlyArray<AgentEvent> = yield* store.listSyncedEventsAfter(
          threadId,
          position.after,
          PAGE,
        );
        for (const batch of batches(page.map(cloudEvent))) {
          if (cursors !== connection) return false;
          if ((yield* Clock.currentTimeMillis) >= deadline) return true;
          const answer = yield* Deferred.make<number>();
          accepted.set(threadId, answer);
          yield* account.send({ _tag: "SyncEvents", threadId, start, events: batch });
          const count = yield* Deferred.await(answer).pipe(
            Effect.timeoutOrElse({ duration: ACCEPT_WITHIN, orElse: () => Effect.succeed(-1) }),
          );
          if (accepted.get(threadId) === answer) accepted.delete(threadId);
          if (cursors !== connection) return false;
          // No answer, or the relay has fewer than it was sent (a gap): try again next round.
          // A larger count can be a retry the relay already stored; resolve its exact anchor next time.
          if (count !== start + batch.length) {
            positions.delete(threadId);
            return false;
          }
          start = count;
          position = { count, after: batch.at(-1)!.id };
          positions.set(threadId, position);
        }
        // A page short of full was the last; asking again would only read an empty one.
        if (page.length < PAGE) return false;
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
          positions.delete(id);
        }
      }

      const counts = yield* store.countSyncedEvents;
      const behind = local
        .filter((overview) => (counts.get(overview.thread.id) ?? 0) > (known.get(overview.thread.id) ?? 0))
        .toSorted((a, b) => lastActive(b) - lastActive(a));
      const deadline = (yield* Clock.currentTimeMillis) + ROUND_BUDGET;
      const cut = yield* Effect.forEach(
        behind,
        ({ thread }) => upload(thread.id, known.get(thread.id) ?? 0, deadline, known),
        { concurrency: UPLOADS },
      );
      // What the budget left goes up in the next round, after whatever happens meanwhile.
      if (cut.some(Boolean)) yield* Queue.offer(kick, undefined);
    }).pipe(Effect.ignore);

    // What the relay says about uploads: where the cloud's copy ends, and what it took.
    yield* Effect.gen(function* () {
      const events = yield* account.relayEvents;
      while (true) {
        const event = yield* PubSub.take(events);
        if (event._tag === "SyncCursors") {
          for (const answer of accepted.values()) yield* Deferred.succeed(answer, -1);
          accepted.clear();
          positions.clear();
          cursors = new Map(Object.entries(event.threads));
          sent.clear();
          yield* Queue.offer(kick, undefined);
        } else if (event._tag === "SyncAccepted") {
          cursors?.set(event.threadId, event.count);
          const answer = accepted.get(event.threadId);
          if (answer !== undefined) yield* Deferred.succeed(answer, event.count);
        } else if (event._tag === "RelayLost") {
          cursors = undefined;
          positions.clear();
          for (const answer of accepted.values()) yield* Deferred.succeed(answer, -1);
          accepted.clear();
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
