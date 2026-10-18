import { UiEvent, type AccountThreads, type DeviceId, type ReadEntry, type ThreadId } from "@cerium/protocol";
import { Context, Effect, Layer, PubSub, Schema, Stream, SubscriptionRef } from "effect";

import { Account, AccountError, type RelayEvent } from "./account.ts";

// The account's threads as a device knows them (docs/architecture.md §14.9): every machine's, as the
// relay tells them, what was seen of them on any device, and reading another machine's thread from
// the cloud copy. A desktop also keeps its own threads' copy current, which its backend does.

const empty: AccountThreads = { threads: [], read: [] };

const decodeEvents = Schema.decodeUnknownEffect(Schema.Array(UiEvent));

/** The account's threads after a notice from the relay. */
export const applyNotice = (current: AccountThreads, event: RelayEvent): AccountThreads => {
  switch (event._tag) {
    case "AccountThreads":
      return { threads: event.threads, read: event.read };
    case "ThreadsChanged": {
      const key = (machine: string, threadId: string) => `${machine}:${threadId}`;
      const gone = new Set(event.removed.map(({ machine, threadId }) => key(machine, threadId)));
      const changed = new Map(
        event.threads.map((each) => [key(each.machine, each.overview.thread.id), each]),
      );
      const kept = current.threads.filter((each) => {
        const id = key(each.machine, each.overview.thread.id);
        return !gone.has(id) && !changed.has(id);
      });
      return { ...current, threads: [...kept, ...changed.values()] };
    }
    case "ReadChanged": {
      const seen = new Map(current.read.map((entry) => [entry.threadId, entry.seenAt]));
      for (const { threadId, seenAt } of event.entries)
        seen.set(threadId, Math.max(seen.get(threadId) ?? 0, seenAt));
      return { ...current, read: [...seen].map(([threadId, seenAt]) => ({ threadId, seenAt })) };
    }
    default:
      return current;
  }
};

export class CloudThreads extends Context.Service<
  CloudThreads,
  {
    /** Every thread of the account and what was seen of them, now and after every change. */
    readonly accountThreads: Stream.Stream<AccountThreads>;
    /** Another machine's thread, read from the cloud copy. */
    cloudEvents(machine: DeviceId, threadId: ThreadId): Effect.Effect<ReadonlyArray<UiEvent>, AccountError>;
    /** Tells the account's other devices these threads were seen here. */
    markRead(entries: ReadonlyArray<ReadEntry>): Effect.Effect<void, AccountError>;
  }
>()("cerium/account/CloudThreads") {
  /** Requires `Account`. */
  static readonly layer = Layer.effect(
    CloudThreads,
    Effect.gen(function* () {
      const account = yield* Account;
      const threads = yield* SubscriptionRef.make<AccountThreads>(empty);

      yield* Effect.gen(function* () {
        const events = yield* account.relayEvents;
        while (true) {
          const event = yield* PubSub.take(events);
          yield* SubscriptionRef.update(threads, (current) => applyNotice(current, event));
        }
      }).pipe(Effect.scoped, Effect.forkScoped);

      // Signed out, this device knows no account's threads.
      yield* account.changes.pipe(
        Stream.runForEach((state) =>
          state._tag === "SignedIn" ? Effect.void : SubscriptionRef.set(threads, empty),
        ),
        Effect.forkScoped,
      );

      return CloudThreads.of({
        accountThreads: SubscriptionRef.changes(threads),
        cloudEvents: (machine, threadId) =>
          account.readThread(machine, threadId).pipe(
            Effect.flatMap(decodeEvents),
            Effect.mapError((error) =>
              error._tag === "AccountError"
                ? error
                : new AccountError({ message: "Cerium's cloud sent a thread Cerium can't read." }),
            ),
          ),
        markRead: (entries) =>
          entries.length === 0 ? Effect.void : account.send({ _tag: "MarkRead", entries }),
      });
    }),
  );
}
