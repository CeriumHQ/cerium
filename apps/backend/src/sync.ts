import { Account } from "@cerium/account";
import { Orchestrator } from "@cerium/orchestrator";
import {
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

/** How often to retry pending work after a failed read, send or acknowledgement. */
const RETRY_EVERY = "15 seconds";
/** How long a round waits to collect changes, so a busy turn goes up in a few batches. */
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

/** When something last happened in a thread, as its overview says: the thread or one of its agents changed. */
export const lastActive = (overview: ThreadOverview): number =>
  Math.max(overview.thread.updatedAt, ...overview.agents.map((agent) => agent.updatedAt));

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

interface SyncConnection {
  /** The relay's counts, including zero for an overview this connection has sent. */
  readonly cursors: Map<ThreadId, number>;
  readonly accepted: Map<ThreadId, Deferred.Deferred<number>>;
  /** Only acknowledged batches advance these anchors. */
  readonly positions: Map<ThreadId, { readonly count: number; readonly after: string | undefined }>;
  readonly overviews: Set<ThreadId>;
  readonly uploads: Set<ThreadId>;
  reconcile: boolean;
}

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

    let connection: SyncConnection | undefined;
    let local: Map<ThreadId, ThreadOverview> | undefined;
    const eventChanges = yield* store.syncedEventChanges;

    /**
     * Sends a thread's events from where the cloud's copy ends, a batch at a time, starting none past
     * `deadline`. A deadline continues in the next round, while errors wait for a retry.
     */
    const upload = Effect.fn("CloudCopy.upload")(function* (
      active: SyncConnection,
      threadId: ThreadId,
      from: number,
      deadline: number,
    ) {
      if (connection !== active) return "done";
      if ((yield* Clock.currentTimeMillis) >= deadline) return "continue";
      let start = from;
      let position = active.positions.get(threadId);
      if (position?.count !== from) {
        position = { count: from, after: yield* store.syncedEventCursor(threadId, from) };
        active.positions.set(threadId, position);
      }
      while (true) {
        if (connection !== active) return "done";
        if ((yield* Clock.currentTimeMillis) >= deadline) return "continue";
        const page: ReadonlyArray<AgentEvent> = yield* store.listSyncedEventsAfter(
          threadId,
          position.after,
          PAGE,
        );
        for (const batch of batches(page.map(cloudEvent))) {
          if (connection !== active) return "done";
          if ((yield* Clock.currentTimeMillis) >= deadline) return "continue";
          const answer = yield* Deferred.make<number>();
          active.accepted.set(threadId, answer);
          const count = yield* account
            .send({ _tag: "SyncEvents", threadId, start, events: batch })
            .pipe(
              Effect.andThen(Deferred.await(answer)),
              Effect.timeoutOrElse({ duration: ACCEPT_WITHIN, orElse: () => Effect.succeed(-1) }),
              Effect.ensuring(Effect.sync(() => active.accepted.delete(threadId))),
            );
          if (connection !== active) return "done";
          // No answer, or the relay has fewer than it was sent (a gap): try again next round.
          // A larger count can be a retry the relay already stored; resolve its exact anchor next time.
          if (count !== start + batch.length) {
            active.positions.delete(threadId);
            return "retry";
          }
          start = count;
          position = { count, after: batch.at(-1)!.id };
          active.positions.set(threadId, position);
        }
        // A page short of full was the last; asking again would only read an empty one.
        if (page.length < PAGE) return "done";
      }
    });

    const syncOverviews = Effect.fn("CloudCopy.syncOverviews")(function* (
      active: SyncConnection,
      snapshot: ReadonlyMap<ThreadId, ThreadOverview>,
    ) {
      const dirty = [...active.overviews];
      active.overviews.clear();
      const changed: ThreadOverview[] = [];
      const gone: ThreadId[] = [];
      for (const id of dirty) {
        const overview = snapshot.get(id);
        if (overview !== undefined) changed.push(overview);
        else if (active.cursors.has(id)) gone.push(id);
      }
      yield* Effect.gen(function* () {
        for (let index = 0; index < changed.length; index += 50) {
          if (connection !== active) return;
          const threads = changed.slice(index, index + 50);
          yield* account.send({ _tag: "SyncThreads", threads });
          for (const { thread } of threads) {
            if (!active.cursors.has(thread.id)) active.cursors.set(thread.id, 0);
          }
        }
        if (gone.length === 0 || connection !== active) return;
        yield* account.send({ _tag: "SyncRemoved", threadIds: gone });
        for (const id of gone) {
          active.cursors.delete(id);
          active.positions.delete(id);
        }
      }).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            for (const id of dirty) active.overviews.add(id);
          }),
        ),
      );
    });

    const round = Effect.gen(function* () {
      const active = connection;
      const snapshot = local;
      if (active === undefined || snapshot === undefined) return;
      if (active.reconcile) {
        const counts = yield* store.countSyncedEvents;
        if (connection !== active) return;
        for (const id of snapshot.keys()) {
          active.overviews.add(id);
          if ((counts.get(id) ?? 0) > (active.cursors.get(id) ?? 0)) active.uploads.add(id);
        }
        for (const id of active.cursors.keys()) {
          if (!snapshot.has(id)) active.overviews.add(id);
        }
        active.reconcile = false;
      }

      if (active.overviews.size > 0) yield* syncOverviews(active, snapshot);
      if (connection !== active || active.uploads.size === 0) return;
      const behind: ThreadOverview[] = [];
      for (const id of active.uploads) {
        const overview = snapshot.get(id);
        if (overview === undefined) active.uploads.delete(id);
        // A thread added during the overview send must wait for its first overview to go up.
        else if (active.cursors.has(id)) {
          active.uploads.delete(id);
          behind.push(overview);
        }
      }
      behind.sort((a, b) => lastActive(b) - lastActive(a));
      const deadline = (yield* Clock.currentTimeMillis) + ROUND_BUDGET;
      const cut = yield* Effect.forEach(
        behind,
        ({ thread: { id } }) =>
          Effect.gen(function* () {
            const result = yield* upload(active, id, active.cursors.get(id) ?? 0, deadline).pipe(
              Effect.orElseSucceed(() => "retry" as const),
            );
            if (result !== "done" && snapshot.has(id)) active.uploads.add(id);
            return result === "continue";
          }),
        { concurrency: UPLOADS },
      );
      // What the budget left goes up in the next round, after whatever happens meanwhile.
      if (cut.some(Boolean)) yield* Queue.offer(kick, undefined);
    }).pipe(Effect.ignore);

    // Each connection starts with the relay's current counts, discarding the old upload anchors.
    const setConnection = (next: SyncConnection | undefined) =>
      Effect.gen(function* () {
        const previous = connection;
        connection = next;
        if (previous !== undefined) {
          for (const answer of previous.accepted.values()) yield* Deferred.succeed(answer, -1);
        }
      });
    const relayEvents = yield* account.relayEvents;
    yield* Effect.gen(function* () {
      while (true) {
        const event = yield* PubSub.take(relayEvents);
        if (event._tag === "SyncCursors") {
          yield* setConnection({
            cursors: new Map(Object.entries(event.threads) as Array<[ThreadId, number]>),
            accepted: new Map(),
            positions: new Map(),
            overviews: new Set(),
            uploads: new Set(),
            reconcile: true,
          });
          yield* Queue.offer(kick, undefined);
        } else if (event._tag === "SyncAccepted") {
          connection?.cursors.set(event.threadId, event.count);
          const answer = connection?.accepted.get(event.threadId);
          if (answer !== undefined) yield* Deferred.succeed(answer, event.count);
        } else if (event._tag === "RelayLost") {
          yield* setConnection(undefined);
        }
      }
    }).pipe(Effect.forkScoped);

    yield* orchestrator.watchThreadOverviews.pipe(
      Stream.runForEach((update) =>
        Effect.gen(function* () {
          const active = connection;
          if (update._tag === "Reset") {
            local = new Map(update.threads.map((overview) => [overview.thread.id, overview]));
          } else if (local !== undefined) {
            // The patch also lists upserted IDs under `removed` for clients that skip unknown rows.
            const removed = new Set(update.removed);
            for (const overview of update.threads) {
              const id = overview.thread.id;
              removed.delete(id);
              if (!local.has(id)) active?.uploads.add(id);
              local.set(id, overview);
              active?.overviews.add(id);
            }
            for (const id of removed) {
              local.delete(id);
              active?.overviews.add(id);
              active?.uploads.delete(id);
            }
          }
          if (active !== undefined) yield* Queue.offer(kick, undefined);
        }),
      ),
      Effect.forkScoped,
    );
    yield* Stream.fromSubscription(eventChanges).pipe(
      Stream.runForEach((id) =>
        Effect.gen(function* () {
          if (connection === undefined || !local?.has(id)) return;
          connection.uploads.add(id);
          yield* Queue.offer(kick, undefined);
        }),
      ),
      Effect.forkScoped,
    );
    yield* Effect.suspend(() => {
      const active = connection;
      return active !== undefined &&
        (active.reconcile || active.overviews.size > 0 || active.uploads.size > 0)
        ? Queue.offer(kick, undefined)
        : Effect.void;
    }).pipe(Effect.delay(RETRY_EVERY), Effect.forever, Effect.forkScoped);
    yield* Queue.take(kick).pipe(
      Effect.andThen(Effect.sleep(SETTLE_FOR)),
      Effect.andThen(round),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
