import type { HarnessStatus } from "@cerium/protocol";
import { Effect, Exit, FileSystem, Stream } from "effect";

import type { AdapterEvent, AgentSession } from "./adapter.ts";

/** How long a probe that found the harness usable is kept. */
const KEEP_USABLE = "5 minutes";

const usable = (status: HarnessStatus) =>
  status._tag === "HarnessInstalled" && status.auth._tag === "LoggedIn";

/**
 * Shares one probe between everything that needs the harness usable (starting sessions, listing
 * models and skills, reading usage, forking and completing) instead of each running its own: a probe
 * runs several of the harness's processes, and some sign-in checks start its whole server. A probe
 * that finds the harness installed and signed in is kept for a while, and nothing else is, so an
 * install or a login shows at once. A sign-out since is the harness's own to report: a session says
 * so at its first turn (`watchSignIn`).
 */
export const shareProbe = <E>(probe: Effect.Effect<HarnessStatus, E>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const [kept, forget] = yield* Effect.cachedInvalidateWithTTL(probe, (exit) =>
      Exit.isSuccess(exit) && usable(exit.value) ? KEEP_USABLE : 0,
    );
    const fresh = Effect.andThen(forget, kept);
    return {
      /** Probes anew, as Settings' Check again asks; what it finds replaces the kept probe. */
      fresh,
      /**
       * The kept probe, or a new one. An executable gone since it was kept (uninstalled, or moved by
       * an update) is probed for anew, so a session isn't started on it.
       */
      kept: kept.pipe(
        Effect.flatMap((status) =>
          status._tag === "HarnessMissing"
            ? Effect.succeed(status)
            : fs.exists(status.executablePath).pipe(
                // Trouble looking reads as still there: the session's own start then says what's wrong.
                Effect.orElseSucceed(() => true),
                Effect.flatMap((there) => (there ? Effect.succeed(status) : fresh)),
              ),
        ),
      ),
      /**
       * A session started on the kept probe, which a sign-out since doesn't show. When the session
       * asks for a login, the kept probe is dropped, so what starts next probes anew, and `signedOut`
       * (what a start would have failed with) follows as an error: the transcript shows errors, not
       * `AuthRequired`. Once a turn, however often the harness asks in it.
       */
      watchSignIn: (session: AgentSession, signedOut: string): AgentSession => {
        let told = false;
        const notice: AdapterEvent = {
          payload: { _tag: "AgentError", kind: "unknown", message: signedOut, retryable: false },
        };
        return {
          ...session,
          events: session.events.pipe(
            Stream.mapEffect((event): Effect.Effect<ReadonlyArray<AdapterEvent>> => {
              if (event.payload._tag === "TurnCompleted") told = false;
              if (event.payload._tag !== "AuthRequired" || told) return Effect.succeed([event]);
              told = true;
              return Effect.as(forget, [event, notice]);
            }),
            Stream.flattenIterable,
          ),
        };
      },
    };
  });
