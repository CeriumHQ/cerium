import { HarnessUnavailable, type HarnessAdapter, type SessionOptions } from "@cerium/harness";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { claudeManifest, INSTALL_HINT, LOGIN_COMMAND } from "./manifest.ts";
import { probeClaude } from "./probe.ts";
import { startClaudeSession } from "./session.ts";

export class ClaudeAdapter extends Context.Service<ClaudeAdapter, HarnessAdapter>()(
  "cerium/adapters/claude/ClaudeAdapter",
) {
  /** Requires the platform's `ChildProcessSpawner`, `FileSystem` and `Path` (e.g. `NodeServices.layer`). */
  static readonly layer = Layer.effect(
    ClaudeAdapter,
    Effect.gen(function* () {
      const platform = yield* Effect.context<
        ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
      >();
      const probe = probeClaude.pipe(Effect.provide(platform));

      const startSession = Effect.fn("ClaudeAdapter.startSession")(function* (options: SessionOptions) {
        const status = yield* probe;
        if (status._tag === "HarnessMissing") {
          return yield* new HarnessUnavailable({
            provider: "claude",
            reason: "notInstalled",
            message: INSTALL_HINT,
          });
        }
        if (status.versionStatus === "tooOld") {
          return yield* new HarnessUnavailable({
            provider: "claude",
            reason: "versionTooOld",
            message: `Claude Code ${status.version} is older than ${claudeManifest.harnessVersion.minimum}. Run \`claude update\`.`,
          });
        }
        if (status.auth._tag === "LoggedOut") {
          return yield* new HarnessUnavailable({
            provider: "claude",
            reason: "loggedOut",
            message: `Claude Code is not logged in. Run \`${LOGIN_COMMAND}\`.`,
          });
        }
        return yield* startClaudeSession(status.executablePath, options);
      });

      return ClaudeAdapter.of({ provider: "claude", manifest: claudeManifest, probe, startSession });
    }),
  );
}
