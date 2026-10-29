import { Effect, Stream } from "effect";
import { Atom } from "effect/reactivity";

import { Backend, connectionEpochAtom } from "./client.ts";

/**
 * The driven machine's subscribed harnesses and their usage meters: the last reading, then each
 * change as the backend reads them again. Refreshing subscribes again, which reads them now. Kept a
 * minute after Settings → Limits closes, so moving between categories doesn't ask again.
 */
export const usageAtom = Backend.runtime
  .atom((get) => {
    get(connectionEpochAtom);
    return Stream.unwrap(
      Backend.use((client) => Effect.succeed(client("WatchSubscriptionUsage", undefined))),
    );
  })
  .pipe(Atom.setIdleTTL("1 minute"));
