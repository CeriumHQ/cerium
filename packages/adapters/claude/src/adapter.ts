import { HarnessUnavailable, shareProbe, type HarnessAdapter, type SessionOptions } from "@cerium/harness";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { completeWithClaude } from "./complete.ts";
import { forkClaudeSession } from "./fork.ts";
import { claudeManifest, INSTALL_HINT, LOGIN_COMMAND } from "./manifest.ts";
import { listClaudeModels } from "./models.ts";
import { probeClaude } from "./probe.ts";
import { listClaudeSessions, readClaudeSession } from "./sessions.ts";
import { startClaudeSession } from "./session.ts";
import { listClaudeSkills } from "./skills.ts";
import { readClaudeUsage } from "./usage.ts";

const SIGNED_OUT = `Claude Code is not logged in. Run \`${LOGIN_COMMAND}\`.`;

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
      const probes = yield* shareProbe(probeClaude.pipe(Effect.provide(platform)));

      /** The installed executable, once it is known to be usable. */
      const ready = Effect.gen(function* () {
        const status = yield* probes.kept;
        if (status._tag === "HarnessMissing") {
          return yield* new HarnessUnavailable({
            provider: "claude",
            reason: "notInstalled",
            message: INSTALL_HINT,
          });
        }
        if (status.auth._tag === "LoggedOut") {
          return yield* new HarnessUnavailable({
            provider: "claude",
            reason: "loggedOut",
            message: SIGNED_OUT,
          });
        }
        return status.executablePath;
      });

      const startSession = Effect.fn("ClaudeAdapter.startSession")(function* (options: SessionOptions) {
        return probes.watchSignIn(yield* startClaudeSession(yield* ready, options), SIGNED_OUT);
      });

      return ClaudeAdapter.of({
        provider: "claude",
        manifest: claudeManifest,
        probe: probes.fresh,
        listModels: ready.pipe(Effect.flatMap(listClaudeModels)),
        listSkills: (cwd) =>
          ready.pipe(Effect.flatMap((executablePath) => listClaudeSkills(executablePath, cwd))),
        usage: ready.pipe(Effect.flatMap(readClaudeUsage)),
        complete: (request) =>
          ready.pipe(Effect.flatMap((executablePath) => completeWithClaude(executablePath, request))),
        fork: forkClaudeSession,
        listSessions: listClaudeSessions,
        readSession: readClaudeSession,
        startSession,
      });
    }),
  );
}
