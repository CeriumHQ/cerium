import {
  HarnessFailure,
  HarnessUnavailable,
  replyTo,
  shareProbe,
  type AdapterEvent,
  type CompletionRequest,
  type HarnessAdapter,
  type SessionOptions,
} from "@cerium/harness";
import { Context, Effect, FileSystem, Layer, Option, Path, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { antigravityManifest, CONSUMER_PLAN_NOTICE, INSTALL_HINT, LOGIN_COMMAND } from "./manifest.ts";
import { parseModels } from "./models.ts";
import { probeAntigravity, runAgy, SIGNED_OUT } from "./probe.ts";
import { defaultGeminiHome, startAntigravitySession } from "./session.ts";
import { listAntigravitySessions } from "./sessions.ts";
import { listAntigravitySkills } from "./skills.ts";
import { parseUsage } from "./usage.ts";

const SIGNED_OUT_MESSAGE = `Antigravity CLI is not signed in. Run \`${LOGIN_COMMAND}\` and sign in.`;

export class AntigravityAdapter extends Context.Service<AntigravityAdapter, HarnessAdapter>()(
  "cerium/adapters/antigravity/AntigravityAdapter",
) {
  /** Requires the platform's `ChildProcessSpawner`, `FileSystem` and `Path` (e.g. `NodeServices.layer`). */
  static readonly layer = Layer.effect(
    AntigravityAdapter,
    Effect.gen(function* () {
      // Only these services: the layer's whole context would also carry its Scope, which would then
      // replace the scope a session is started in.
      const platform = Context.pick(
        ChildProcessSpawner.ChildProcessSpawner,
        FileSystem.FileSystem,
        Path.Path,
      )(yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path>());
      const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, platform);
      const geminiHome = defaultGeminiHome();
      const probes = yield* shareProbe(provide(probeAntigravity(geminiHome)));

      const ready = Effect.gen(function* () {
        const status = yield* probes.kept;
        if (status._tag === "HarnessMissing") {
          return yield* new HarnessUnavailable({
            provider: "antigravity",
            reason: "notInstalled",
            message: INSTALL_HINT,
          });
        }
        if (status.auth._tag === "LoggedOut") {
          return yield* new HarnessUnavailable({
            provider: "antigravity",
            reason: "loggedOut",
            message: SIGNED_OUT_MESSAGE,
          });
        }
        return status;
      });

      // Said once per backend run, to a session on a personal Google account.
      let told = false;
      const startSession = (options: SessionOptions) =>
        Effect.gen(function* () {
          const status = yield* ready;
          const session = yield* provide(
            startAntigravitySession(status.executablePath, options, { geminiHome }),
          );
          const personal = status.auth._tag === "LoggedIn" && status.auth.method === "google";
          const watched = probes.watchSignIn(session, SIGNED_OUT_MESSAGE);
          if (!personal || told) return watched;
          told = true;
          const notice: AdapterEvent = {
            payload: { _tag: "AgentError", kind: "unknown", message: CONSUMER_PLAN_NOTICE, retryable: false },
          };
          return { ...watched, events: Stream.concat(Stream.make(notice), watched.events) };
        });

      const listModels = Effect.gen(function* () {
        const status = yield* ready;
        const printed = yield* provide(runAgy(status.executablePath, ["models"], "45 seconds"));
        if (printed.code !== 0) {
          if (SIGNED_OUT.test(`${printed.stderr}\n${printed.stdout}`)) {
            return yield* new HarnessUnavailable({
              provider: "antigravity",
              reason: "loggedOut",
              message: SIGNED_OUT_MESSAGE,
            });
          }
          return yield* new HarnessFailure({
            provider: "antigravity",
            message: `\`agy models\` failed: ${printed.stderr.trim().split("\n").at(-1) ?? ""}`,
            cause: printed,
          });
        }
        return parseModels(printed.stdout);
      });

      /** Cerium's small jobs run as a read-only session whose instructions open the agent's prompt. */
      const complete = (request: CompletionRequest) =>
        Effect.gen(function* () {
          const status = yield* ready;
          const session = yield* provide(
            startAntigravitySession(
              status.executablePath,
              {
                cwd: request.cwd,
                model: request.model,
                effort: "low",
                access: "readOnly",
                mcpServers: {},
                includeUserMcpServers: false,
                appendSystemPrompt: request.instructions,
              },
              { geminiHome },
            ),
          );
          return yield* replyTo(session, "antigravity", request.prompt, request.onUsage);
        }).pipe(Effect.scoped);

      const usage = Effect.gen(function* () {
        const status = yield* ready;
        // A personal account's quota and an API key's alike; a key without one prints no meters.
        const printed = yield* provide(runAgy(status.executablePath, ["-p", "/usage"], "45 seconds"));
        if (printed.code !== 0) return Option.none();
        return parseUsage(printed.stdout);
      });

      return AntigravityAdapter.of({
        provider: "antigravity",
        manifest: antigravityManifest,
        probe: probes.fresh,
        listModels,
        complete,
        usage,
        listSkills: (cwd) => ready.pipe(Effect.andThen(listAntigravitySkills(cwd, geminiHome))),
        listSessions: ready.pipe(Effect.andThen(listAntigravitySessions(geminiHome))),
        startSession,
      });
    }),
  );
}
