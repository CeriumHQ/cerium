import { HarnessUnavailable, type HarnessAdapter, type SessionOptions } from "@cerium/harness";
import { Context, Effect, Exit, FileSystem, Layer, Path } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { completeWithClaude } from "./complete.ts";
import { forkClaudeSession } from "./fork.ts";
import { claudeManifest, INSTALL_HINT, LOGIN_COMMAND } from "./manifest.ts";
import { listClaudeModels } from "./models.ts";
import { probeClaude } from "./probe.ts";
import { startClaudeSession } from "./session.ts";
import { listClaudeSkills } from "./skills.ts";
import { readClaudeUsage } from "./usage.ts";

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

      /** The installed executable, once it is known to be usable. */
      const ready = Effect.gen(function* () {
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
        return status.executablePath;
      });
      // Completions are meant to be quick, so they skip the probe for a while after one passes.
      const readyForCompletion = yield* ready.pipe(
        Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? "5 minutes" : 0)),
      );

      const startSession = Effect.fn("ClaudeAdapter.startSession")(function* (options: SessionOptions) {
        return yield* startClaudeSession(yield* ready, options);
      });

      return ClaudeAdapter.of({
        provider: "claude",
        manifest: claudeManifest,
        probe,
        listModels: ready.pipe(Effect.flatMap(listClaudeModels)),
        listSkills: (cwd) =>
          ready.pipe(Effect.flatMap((executablePath) => listClaudeSkills(executablePath, cwd))),
        usage: ready.pipe(Effect.flatMap(readClaudeUsage)),
        complete: (request) =>
          readyForCompletion.pipe(
            Effect.flatMap((executablePath) => completeWithClaude(executablePath, request)),
          ),
        fork: forkClaudeSession,
        startSession,
      });
    }),
  );
}
