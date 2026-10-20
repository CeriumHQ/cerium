import { HarnessUnavailable, type HarnessAdapter, type SessionOptions } from "@cerium/harness";
import { Context, Effect, Exit, FileSystem, Layer, Path, RcRef } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { tmpdir } from "node:os";

import { completeWithOpenCode } from "./complete.ts";
import { forkOpenCodeSession } from "./fork.ts";
import { openHost, type OpenCodeClient } from "./host.ts";
import { INSTALL_HINT, LOGIN_COMMAND, opencodeManifest } from "./manifest.ts";
import { readCatalog, toModelInfos } from "./models.ts";
import { probeOpenCode, readAuth } from "./probe.ts";
import { startOpenCodeSession } from "./session.ts";
import { listOpenCodeSkills } from "./skills.ts";

/** How long the shared server stays up after its last use. */
const SHARED_IDLE = "3 minutes";

export class OpenCodeAdapter extends Context.Service<OpenCodeAdapter, HarnessAdapter>()(
  "cerium/adapters/opencode/OpenCodeAdapter",
) {
  /** Requires the platform's `ChildProcessSpawner`, `FileSystem` and `Path` (e.g. `NodeServices.layer`). */
  static readonly layer = Layer.effect(
    OpenCodeAdapter,
    Effect.gen(function* () {
      // Only these services: the layer's whole context would also carry its Scope, which would then
      // replace the scope a session is started in.
      const platform = Context.pick(
        ChildProcessSpawner.ChildProcessSpawner,
        FileSystem.FileSystem,
        Path.Path,
      )(yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path>());

      // Probing, listing models and skills and completing all talk to one server, started on first use
      // and stopped once nothing has needed it for a while. Its folder is the system's temp folder, so
      // no project's configuration loads; sessions start servers of their own.
      let executable = "";
      const shared = yield* RcRef.make({
        acquire: Effect.suspend(() => openHost(executable, { cwd: tmpdir() })).pipe(Effect.provide(platform)),
        idleTimeToLive: SHARED_IDLE,
      });
      const withServer = <A, E>(
        executablePath: string,
        use: (client: OpenCodeClient) => Effect.Effect<A, E>,
      ) =>
        Effect.gen(function* () {
          // A new install path (an update moved it) needs a new server.
          if (executable !== executablePath) {
            if (executable !== "") yield* RcRef.invalidate(shared);
            executable = executablePath;
          }
          const host = yield* RcRef.get(shared);
          return yield* use(host.client);
        }).pipe(
          // A server that failed a call may have stopped; the next call starts a fresh one.
          Effect.tapError(() => RcRef.invalidate(shared)),
          Effect.scoped,
        );

      const probe = probeOpenCode((executablePath) => withServer(executablePath, readAuth)).pipe(
        Effect.provide(platform),
      );

      /** The installed executable, once it is known to be usable. */
      const ready = Effect.gen(function* () {
        const status = yield* probe;
        if (status._tag === "HarnessMissing") {
          return yield* new HarnessUnavailable({
            provider: "opencode",
            reason: "notInstalled",
            message: INSTALL_HINT,
          });
        }
        if (status.versionStatus === "tooOld") {
          return yield* new HarnessUnavailable({
            provider: "opencode",
            reason: "versionTooOld",
            message: `OpenCode ${status.version} is older than ${opencodeManifest.harnessVersion.minimum}. Update OpenCode (\`opencode upgrade\`).`,
          });
        }
        if (status.auth._tag === "LoggedOut") {
          return yield* new HarnessUnavailable({
            provider: "opencode",
            reason: "loggedOut",
            message: `OpenCode has no models to run. Run \`${LOGIN_COMMAND}\`.`,
          });
        }
        return status.executablePath;
      });
      // Completions are meant to be quick, so they skip the probe for a while after one passes.
      const readyForCompletion = yield* ready.pipe(
        Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? "5 minutes" : 0)),
      );

      const startSession = Effect.fn("OpenCodeAdapter.startSession")(function* (options: SessionOptions) {
        return yield* startOpenCodeSession(yield* ready, options).pipe(Effect.provide(platform));
      });

      return OpenCodeAdapter.of({
        provider: "opencode",
        manifest: opencodeManifest,
        probe,
        listModels: ready.pipe(
          Effect.flatMap((executablePath) =>
            withServer(executablePath, (client) => readCatalog(client, tmpdir())),
          ),
          Effect.map(({ rows, defaultRow }) => toModelInfos(rows, defaultRow)),
        ),
        listSkills: (cwd) =>
          ready.pipe(
            Effect.flatMap((executablePath) =>
              withServer(executablePath, (client) => listOpenCodeSkills(client, cwd)),
            ),
          ),
        complete: (request) =>
          readyForCompletion.pipe(
            Effect.flatMap((executablePath) =>
              withServer(executablePath, (client) =>
                readCatalog(client, request.cwd).pipe(
                  Effect.flatMap(({ rows }) => completeWithOpenCode(client, request, rows)),
                ),
              ),
            ),
          ),
        fork: (request) =>
          ready.pipe(
            Effect.flatMap((executablePath) =>
              withServer(executablePath, (client) => forkOpenCodeSession(client, request)),
            ),
          ),
        startSession,
      });
    }),
  );
}
