import type { ThreadId } from "@cerium/protocol";
import { Effect, Schedule, Stream } from "effect";
import { Atom } from "effect/reactivity";

import { Backend } from "./client.ts";
import { machineAtom } from "./machine.ts";

// The pushes agents made with Cerium's `push` tool, as a thread shows them: each push's checks on
// the user's computer, then GitHub's, followed by the backend until they finish.

/** A thread's pushes, oldest first, now and after every change; subscribed again after a lost connection. */
export const pushesAtom = Atom.family((threadId: ThreadId) =>
  Backend.runtime
    .atom((get) => {
      get(machineAtom);
      return Stream.unwrap(Backend.use((client) => Effect.succeed(client("WatchPushes", { threadId })))).pipe(
        Stream.retry(Schedule.spaced("2 seconds")),
      );
    })
    .pipe(Atom.setIdleTTL("1 minute")),
);

/** Re-runs a push's failed checks, cancels its runs, or hands its failures to the agent. */
export const pushAction = Backend.mutation("PushAction");
