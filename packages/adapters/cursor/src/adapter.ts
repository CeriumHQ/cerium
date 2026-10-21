import { HarnessUnavailable, type HarnessAdapter, type SessionOptions } from "@cerium/harness";
import { Context, Effect, Exit, FileSystem, Layer, Path } from "effect";
import type { ChildProcessSpawner } from "effect/process";

import { completeWithCursor } from "./complete.ts";
import { cursorLogin } from "./login.ts";
import { cursorManifest } from "./manifest.ts";
import { fetchModelCatalog, toModelInfo } from "./models.ts";
import { makeCursorProbe } from "./probe.ts";
import { startCursorSession } from "./session.ts";

export class CursorAdapter extends Context.Service<CursorAdapter, HarnessAdapter>()(
  "cerium/adapters/cursor/CursorAdapter",
) {
  /**
   * Requires the platform's `ChildProcessSpawner`, `FileSystem` and `Path` (e.g. `NodeServices.layer`),
   * like every adapter, so the backend wires them alike. Cursor itself runs in-process and spawns nothing.
   */
  static readonly layer = Layer.effect(
    CursorAdapter,
    Effect.gen(function* () {
      const platform = yield* Effect.context<
        ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
      >();
      // Probing, listing and starting all read the account's model list; one request serves them for a
      // while. Failures are not kept, so logging in takes effect on the next call.
      const catalog = yield* fetchModelCatalog.pipe(
        Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? "10 minutes" : 0)),
      );
      const probe = makeCursorProbe(catalog).pipe(Effect.provide(platform));

      /** Succeeds once the SDK is usable and can authenticate. */
      const ready = Effect.gen(function* () {
        // The SDK ships with Cerium, so it is never missing; only its login can be.
        const status = yield* probe;
        if (status.versionStatus === "tooOld") {
          return yield* new HarnessUnavailable({
            provider: "cursor",
            reason: "versionTooOld",
            message: `@cursor/sdk ${status.version} is older than ${cursorManifest.harnessVersion?.minimum ?? "unknown"}.`,
          });
        }
        if (status.auth._tag === "LoggedOut") {
          return yield* new HarnessUnavailable({
            provider: "cursor",
            reason: "loggedOut",
            message: "Cursor is not signed in. Sign in under Settings → Harnesses.",
          });
        }
      });

      // Completions are meant to be quick, so they skip the probe for a while after one passes.
      const readyForCompletion = yield* ready.pipe(
        Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? "5 minutes" : 0)),
      );

      const startSession = Effect.fn("CursorAdapter.startSession")(function* (options: SessionOptions) {
        yield* ready;
        return yield* startCursorSession(options, catalog);
      });

      return CursorAdapter.of({
        provider: "cursor",
        manifest: cursorManifest,
        probe,
        login: cursorLogin,
        listModels: ready.pipe(
          Effect.andThen(catalog),
          Effect.map((models) => models.map(toModelInfo)),
        ),
        complete: (request) =>
          readyForCompletion.pipe(
            Effect.andThen(completeWithCursor(request, catalog)),
            Effect.provide(platform),
          ),
        startSession,
      });
    }),
  );
}
