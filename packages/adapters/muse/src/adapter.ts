import { HarnessUnavailable, type HarnessAdapter, type SessionOptions } from "@cerium/harness";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { INSTALL_HINT, LOGIN_COMMAND, museManifest } from "./manifest.ts";
import { listMuseModels } from "./models.ts";
import { probeMuse } from "./probe.ts";
import { startMuseSession } from "./session.ts";

export class MuseAdapter extends Context.Service<MuseAdapter, HarnessAdapter>()(
  "cerium/adapters/muse/MuseAdapter",
) {
  /** Requires the platform's `ChildProcessSpawner`, `FileSystem` and `Path` (e.g. `NodeServices.layer`). */
  static readonly layer = Layer.effect(
    MuseAdapter,
    Effect.gen(function* () {
      const platform = yield* Effect.context<
        ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
      >();
      const probe = probeMuse.pipe(Effect.provide(platform));

      /** The installed executable, once it is known to be usable. */
      const ready = Effect.gen(function* () {
        const status = yield* probe;
        if (status._tag === "HarnessMissing") {
          return yield* new HarnessUnavailable({
            provider: "muse",
            reason: "notInstalled",
            message: INSTALL_HINT,
          });
        }
        if (status.versionStatus === "tooOld") {
          return yield* new HarnessUnavailable({
            provider: "muse",
            reason: "versionTooOld",
            message: `Muse Code ${status.version} is older than ${museManifest.harnessVersion.minimum}. Run \`muse\` to update it.`,
          });
        }
        if (status.auth._tag === "LoggedOut") {
          return yield* new HarnessUnavailable({
            provider: "muse",
            reason: "loggedOut",
            message: `Muse Code is not logged in. Run \`${LOGIN_COMMAND}\`.`,
          });
        }
        return status.executablePath;
      });

      const startSession = Effect.fn("MuseAdapter.startSession")(function* (options: SessionOptions) {
        return yield* startMuseSession(yield* ready, options);
      });

      return MuseAdapter.of({
        provider: "muse",
        manifest: museManifest,
        probe,
        listModels: ready.pipe(Effect.flatMap(listMuseModels)),
        startSession,
      });
    }),
  );
}
