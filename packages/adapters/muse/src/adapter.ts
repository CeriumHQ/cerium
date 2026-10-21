import {
  HarnessUnavailable,
  type AdapterEvent,
  type HarnessAdapter,
  type SessionOptions,
} from "@cerium/harness";
import { Context, Effect, Exit, FileSystem, Layer, Path, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { completeWithMuse } from "./complete.ts";
import { INSTALL_HINT, LOGIN_COMMAND, museManifest } from "./manifest.ts";
import { listMuseModels } from "./models.ts";
import { sandboxInstructions, sandboxNotice } from "./policy.ts";
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

      /** The installed harness, once it is known to be usable. */
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
            message: `Muse Code ${status.version} is older than ${museManifest.harnessVersion?.minimum ?? "unknown"}. Run \`muse\` to update it.`,
          });
        }
        if (status.auth._tag === "LoggedOut") {
          return yield* new HarnessUnavailable({
            provider: "muse",
            reason: "loggedOut",
            message: `Muse Code is not logged in. Run \`${LOGIN_COMMAND}\`.`,
          });
        }
        return status;
      });
      // Completions are meant to be quick, so they skip the probe for a while after one passes.
      const readyForCompletion = yield* ready.pipe(
        Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? "5 minutes" : 0)),
      );

      const startSession = Effect.fn("MuseAdapter.startSession")(function* (options: SessionOptions) {
        const { executablePath: executable, setup } = yield* ready;
        // Commands in this mode would fail until the sandbox is set up: tell the agent and the user.
        const problem = setup?.blocks.includes(options.access) ? setup.reason : undefined;
        if (problem === undefined) return yield* startMuseSession(executable, options);
        const session = yield* startMuseSession(executable, {
          ...options,
          appendSystemPrompt: [options.appendSystemPrompt, sandboxInstructions(problem)]
            .filter((part) => part !== undefined)
            .join("\n\n"),
        });
        const notice: AdapterEvent = {
          payload: { _tag: "AgentError", kind: "unknown", message: sandboxNotice(problem), retryable: false },
        };
        return { ...session, events: Stream.concat(Stream.make(notice), session.events) };
      });

      return MuseAdapter.of({
        provider: "muse",
        manifest: museManifest,
        probe,
        listModels: ready.pipe(Effect.flatMap((status) => listMuseModels(status.executablePath))),
        complete: (request) =>
          readyForCompletion.pipe(
            Effect.flatMap((status) => completeWithMuse(status.executablePath, request)),
          ),
        startSession,
      });
    }),
  );
}
