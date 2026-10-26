import { HarnessUnavailable, shareProbe, type HarnessAdapter, type SessionOptions } from "@cerium/harness";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { completeWithCodex } from "./complete.ts";
import { forkCodexThread } from "./fork.ts";
import { codexManifest, INSTALL_HINT, LOGIN_COMMAND } from "./manifest.ts";
import { listCodexModels, listCodexSkills } from "./models.ts";
import { probeCodex } from "./probe.ts";
import { startCodexSession } from "./session.ts";
import { listCodexSessions, readCodexSession } from "./sessions.ts";
import { readCodexUsage } from "./usage.ts";

const SIGNED_OUT = `Codex is not logged in. Run \`${LOGIN_COMMAND}\`.`;

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
      const probes = yield* shareProbe(probeCodex.pipe(Effect.provide(platform)));

      /** The installed executable, once it is known to be usable. */
      const ready = Effect.gen(function* () {
        const status = yield* probes.kept;
        if (status._tag === "HarnessMissing") {
          return yield* new HarnessUnavailable({
            provider: "codex",
            reason: "notInstalled",
            message: INSTALL_HINT,
          });
        }
        if (status.auth._tag === "LoggedOut") {
          return yield* new HarnessUnavailable({
            provider: "codex",
            reason: "loggedOut",
            message: SIGNED_OUT,
          });
        }
        return status.executablePath;
      });

      const startSession = Effect.fn("CodexAdapter.startSession")(function* (options: SessionOptions) {
        const session = yield* startCodexSession(yield* ready, options).pipe(Effect.provide(platform));
        return probes.watchSignIn(session, SIGNED_OUT);
      });

      return CodexAdapter.of({
        provider: "codex",
        manifest: codexManifest,
        probe: probes.fresh,
        listModels: ready.pipe(Effect.flatMap(listCodexModels), Effect.provide(platform)),
        listSkills: (cwd) =>
          ready.pipe(
            Effect.flatMap((executablePath) => listCodexSkills(executablePath, cwd)),
            Effect.provide(platform),
          ),
        usage: ready.pipe(Effect.flatMap(readCodexUsage), Effect.provide(platform)),
        complete: (request) =>
          ready.pipe(
            Effect.flatMap((executablePath) => completeWithCodex(executablePath, request)),
            Effect.provide(platform),
          ),
        fork: (request) =>
          ready.pipe(
            Effect.flatMap((executablePath) => forkCodexThread(executablePath, request)),
            Effect.provide(platform),
          ),
        listSessions: ready.pipe(Effect.flatMap(listCodexSessions), Effect.provide(platform)),
        readSession: (session) =>
          ready.pipe(
            Effect.flatMap((executablePath) => readCodexSession(executablePath, session)),
            Effect.provide(platform),
          ),
        startSession,
      });
    }),
  );
}
