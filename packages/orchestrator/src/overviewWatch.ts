import type { ThreadOverview, ThreadOverviewUpdate } from "@cerium/protocol";
import { Effect, PubSub, Queue, Stream } from "effect";

const same = (a: ThreadOverview, b: ThreadOverview) =>
  a.awaitingApproval === b.awaitingApproval &&
  ((a.thread === b.thread &&
    a.agents.length === b.agents.length &&
    a.agents.every((agent, i) => agent === b.agents[i])) ||
    JSON.stringify(a) === JSON.stringify(b));

export const overviewDiff = (before: ReadonlyArray<ThreadOverview>, after: ReadonlyArray<ThreadOverview>) => {
  const previous = new Map(before.map((overview) => [overview.thread.id, overview]));
  const threads = after.filter((overview) => {
    const earlier = previous.get(overview.thread.id);
    previous.delete(overview.thread.id);
    return earlier === undefined || !same(earlier, overview);
  });
  return { threads, removed: [...previous.keys(), ...threads.map((overview) => overview.thread.id)] };
};

interface Snapshot {
  readonly revision: number;
  readonly all: ReadonlyArray<ThreadOverview>;
  readonly patch: Extract<ThreadOverviewUpdate, { _tag: "Patch" }>;
}

/** One bounded, shared read loop for every window, remote client and browser-page owner. */
export const makeOverviewWatch = Effect.fn("Orchestrator.makeOverviewWatch")(function* <E>(
  read: Effect.Effect<ReadonlyArray<ThreadOverview>, E>,
  dirty: Queue.Queue<void>,
) {
  const snapshots = yield* PubSub.sliding<Snapshot>({ capacity: 1, replay: 1 });
  let current: Snapshot = {
    revision: 0,
    all: yield* read,
    patch: { _tag: "Patch", revision: 0, threads: [], removed: [] },
  };
  yield* PubSub.publish(snapshots, current);
  yield* Effect.gen(function* () {
    yield* Queue.take(dirty);
    yield* Effect.sleep("250 millis");
    const all = yield* read;
    const diff = overviewDiff(current.all, all);
    if (diff.threads.length === 0 && diff.removed.length === 0) return;
    const revision = current.revision + 1;
    current = { revision, all, patch: { _tag: "Patch", revision, ...diff } };
    yield* PubSub.publish(snapshots, current);
  }).pipe(
    Effect.catch(() => Effect.sleep("1 second").pipe(Effect.andThen(Queue.offer(dirty, undefined)))),
    Effect.forever,
    Effect.forkScoped,
  );
  // Sliding snapshots bound memory for slow viewers. If one skips revisions, diff its last snapshot
  // against the newest complete state rather than dropping patches and losing an archive or rename.
  return Stream.fromPubSub(snapshots).pipe(
    Stream.mapAccum(
      () => undefined as Snapshot | undefined,
      (before, after): readonly [Snapshot, ReadonlyArray<ThreadOverviewUpdate>] => [
        after,
        [
          before === undefined
            ? { _tag: "Reset", revision: after.revision, threads: after.all }
            : before.revision === after.revision - 1
              ? after.patch
              : { _tag: "Patch", revision: after.revision, ...overviewDiff(before.all, after.all) },
        ],
      ],
    ),
  );
});
