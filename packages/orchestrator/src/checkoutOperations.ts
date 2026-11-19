import { Deferred, Effect } from "effect";
import { sep } from "node:path";

/** Ordinary commands may overlap. A restore must wait for commands in either an ancestor
 * or a descendant folder, including commands already queued behind an earlier restore. */
export function checkoutOperations() {
  interface Request {
    readonly folders: ReadonlyArray<string>;
    readonly writes: boolean;
    readonly done: Deferred.Deferred<void>;
  }
  const requests = new Set<Request>();
  const contains = (parent: string, child: string) =>
    parent === child || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  return <A, E, R>(folders: ReadonlyArray<string>, writes: boolean, operation: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const request = { folders, writes, done: Deferred.makeUnsafe<void>() };
        const ahead = [...requests].filter(
          (other) =>
            (writes || other.writes) &&
            folders.some((a) => other.folders.some((b) => contains(a, b) || contains(b, a))),
        );
        requests.add(request);
        return { request, ahead };
      }),
      ({ ahead }) =>
        Effect.forEach(ahead, (other) => Deferred.await(other.done), { discard: true }).pipe(
          Effect.andThen(operation),
        ),
      ({ request }) =>
        Effect.sync(() => {
          requests.delete(request);
          Deferred.doneUnsafe(request.done, Effect.void);
        }),
    );
}
