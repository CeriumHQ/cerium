import {
  HarnessUnavailable,
  shareProbe,
  type AdapterEvent,
  type HarnessAdapter,
  type SessionOptions,
} from "@cerium/harness";
import { Context, Effect, FileSystem, Layer, Path, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { completeWithMuse } from "./complete.ts";
import { INSTALL_HINT, LOGIN_COMMAND, museManifest } from "./manifest.ts";
import { listMuseModels } from "./models.ts";
import { limitInstructions, limitNotice, sandboxInstructions, sandboxNotice } from "./policy.ts";
import { probeMuse } from "./probe.ts";
import { startMuseSession } from "./session.ts";

const SIGNED_OUT = `Muse Code is not logged in. Run \`${LOGIN_COMMAND}\`.`;

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
      const probes = yield* shareProbe(probeMuse.pipe(Effect.provide(platform)));

      /** The installed harness, once it is known to be usable. */
      const ready = Effect.gen(function* () {
        const status = yield* probes.kept;
        if (status._tag === "HarnessMissing") {
          return yield* new HarnessUnavailable({
            provider: "muse",
            reason: "notInstalled",
            message: INSTALL_HINT,
          });
        }
        if (status.auth._tag === "LoggedOut") {
          return yield* new HarnessUnavailable({
            provider: "muse",
            reason: "loggedOut",
            message: SIGNED_OUT,
          });
        }
        return status;
      });

      const startSession = Effect.fn("MuseAdapter.startSession")(function* (options: SessionOptions) {
        const { executablePath: executable, setup, limit } = yield* ready;
        // Commands in this mode would fail, until the sandbox is set up or for as long as Muse can't
        // sandbox them here: tell the agent and the user.
        const blocked = setup?.blocks.includes(options.access)
          ? { instructions: sandboxInstructions(setup.reason), notice: sandboxNotice(setup.reason) }
          : limit?.blocks.includes(options.access)
            ? { instructions: limitInstructions, notice: limitNotice }
            : undefined;
        if (blocked === undefined) {
          return probes.watchSignIn(yield* startMuseSession(executable, options), SIGNED_OUT);
        }
        const session = yield* startMuseSession(executable, {
          ...options,
          appendSystemPrompt: [options.appendSystemPrompt, blocked.instructions]
            .filter((part) => part !== undefined)
            .join("\n\n"),
        });
        const notice: AdapterEvent = {
          payload: { _tag: "AgentError", kind: "unknown", message: blocked.notice, retryable: false },
        };
        return probes.watchSignIn(
          { ...session, events: Stream.concat(Stream.make(notice), session.events) },
          SIGNED_OUT,
        );
      });

      return MuseAdapter.of({
        provider: "muse",
        manifest: museManifest,
        probe: probes.fresh,
        listModels: ready.pipe(Effect.flatMap((status) => listMuseModels(status.executablePath))),
        complete: (request) =>
          ready.pipe(Effect.flatMap((status) => completeWithMuse(status.executablePath, request))),
        startSession,
      });
    }),
  );
}
