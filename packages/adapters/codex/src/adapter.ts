import { HarnessUnavailable, type HarnessAdapter, type SessionOptions } from "@cerium/harness";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { codexManifest, INSTALL_HINT, LOGIN_COMMAND } from "./manifest.ts";
import { listCodexModels } from "./models.ts";
import { probeCodex } from "./probe.ts";
import { startCodexSession } from "./session.ts";

export class CodexAdapter extends Context.Service<CodexAdapter, HarnessAdapter>()(
  "cerium/adapters/codex/CodexAdapter",
) {
  /** Requires the platform's `ChildProcessSpawner`, `FileSystem` and `Path` (e.g. `NodeServices.layer`). */
  static readonly layer = Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      // Only these services: the layer's whole context would also carry its Scope, which would then
      // replace the scope a session is started in.
      const platform = Context.pick(
        ChildProcessSpawner.ChildProcessSpawner,
        FileSystem.FileSystem,
        Path.Path,
      )(yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path>());
      const probe = probeCodex.pipe(Effect.provide(platform));

      /** The installed executable, once it is known to be usable. */
      const ready = Effect.gen(function* () {
        const status = yield* probe;
        if (status._tag === "HarnessMissing") {
          return yield* new HarnessUnavailable({
            provider: "codex",
            reason: "notInstalled",
            message: INSTALL_HINT,
          });
        }
        if (status.versionStatus === "tooOld") {
          return yield* new HarnessUnavailable({
            provider: "codex",
            reason: "versionTooOld",
            message: `Codex ${status.version} is older than ${codexManifest.harnessVersion.minimum}. Update the Codex CLI.`,
          });
        }
        if (status.auth._tag === "LoggedOut") {
          return yield* new HarnessUnavailable({
            provider: "codex",
            reason: "loggedOut",
            message: `Codex is not logged in. Run \`${LOGIN_COMMAND}\`.`,
          });
        }
        return status.executablePath;
      });

      const startSession = Effect.fn("CodexAdapter.startSession")(function* (options: SessionOptions) {
        return yield* startCodexSession(yield* ready, options).pipe(Effect.provide(platform));
      });

      return CodexAdapter.of({
        provider: "codex",
        manifest: codexManifest,
        probe,
        listModels: ready.pipe(Effect.flatMap(listCodexModels), Effect.provide(platform)),
        startSession,
      });
    }),
  );
}
