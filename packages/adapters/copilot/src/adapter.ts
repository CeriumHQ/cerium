import {
  HarnessUnavailable,
  scratchFolder,
  shareProbe,
  type CompletionRequest,
  type HarnessAdapter,
  type SessionOptions,
} from "@cerium/harness";
import type { HarnessStatus } from "@cerium/protocol";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { resolve } from "node:path";

import { completeWithCopilot } from "./complete.ts";
import { copilotManifest, INSTALL_HINT, SIGN_IN } from "./manifest.ts";
import { listCopilotModels } from "./models.ts";
import { findCopilotExecutable, readAuth, readVersion } from "./probe.ts";
import { failure, openCopilot } from "./rpc.ts";
import { startCopilotSession } from "./session.ts";

export class CopilotAdapter extends Context.Service<CopilotAdapter, HarnessAdapter>()(
  "cerium/adapters/copilot/CopilotAdapter",
) {
  /** Provide the standard platform services, for example NodeServices.layer. */
  static readonly layer = Layer.effect(
    CopilotAdapter,
    Effect.gen(function* () {
      const platform = Context.pick(
        ChildProcessSpawner.ChildProcessSpawner,
        FileSystem.FileSystem,
        Path.Path,
      )(yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path>());
      const scratch = scratchFolder("copilot", "cerium-copilot").pipe(Effect.provide(platform));
      const probe = Effect.gen(function* () {
        const executablePath = yield* findCopilotExecutable;
        if (!executablePath) {
          return {
            _tag: "HarnessMissing",
            provider: "copilot",
            installHint: INSTALL_HINT,
          } satisfies HarnessStatus;
        }
        const version = yield* readVersion(executablePath);
        const auth = yield* openCopilot(executablePath, yield* scratch).pipe(
          Effect.flatMap(readAuth),
          Effect.scoped,
        );
        return {
          _tag: "HarnessInstalled",
          provider: "copilot",
          executablePath,
          version,
          auth,
        } satisfies HarnessStatus;
      }).pipe(Effect.provide(platform));
      const probes = yield* shareProbe(probe);

      const ready = Effect.gen(function* () {
        const status = yield* probes.kept;
        if (status._tag === "HarnessMissing") {
          return yield* new HarnessUnavailable({
            provider: "copilot",
            reason: "notInstalled",
            message: INSTALL_HINT,
          });
        }
        if (status.auth._tag === "LoggedOut") {
          return yield* new HarnessUnavailable({
            provider: "copilot",
            reason: "loggedOut",
            message: SIGN_IN,
          });
        }
        return status.executablePath;
      });

      return CopilotAdapter.of({
        provider: "copilot",
        hubInstructions: {
          files: [
            { path: ".github/copilot-instructions.md", primary: true, imports: true },
            { path: "AGENTS.md" },
            { path: "CLAUDE.md", imports: true },
            { path: ".claude/CLAUDE.md", imports: true },
            { path: "GEMINI.md" },
          ],
          folders: [
            { path: ".github/instructions", suffix: ".instructions.md", recursive: true },
            { path: ".claude/rules", suffix: ".md", recursive: true },
          ],
        },
        manifest: copilotManifest,
        probe: probes.fresh.pipe(
          Effect.catchTag("HarnessUnavailable", (error) => Effect.fail(failure(error.message)(undefined))),
        ),
        listModels: Effect.gen(function* () {
          const host = yield* openCopilot(yield* ready, yield* scratch);
          return yield* listCopilotModels(host);
        }).pipe(Effect.scoped),
        startSession: (options: SessionOptions) =>
          Effect.gen(function* () {
            const cwd = resolve(options.cwd);
            // The process itself starts outside the workspace. Copilot receives the workspace at session creation.
            const host = yield* openCopilot(yield* ready, yield* scratch);
            const models = yield* listCopilotModels(host);
            const session = yield* startCopilotSession(host, { options: { ...options, cwd }, models });
            return probes.watchSignIn(session, SIGN_IN);
          }),
        complete: (request: CompletionRequest) =>
          Effect.gen(function* () {
            const host = yield* openCopilot(yield* ready, yield* scratch);
            return yield* completeWithCopilot(host, request, yield* listCopilotModels(host));
          }).pipe(Effect.scoped),
      });
    }),
  );
}
