import { listAcpSessions, probeWorkspace, readAcpSession, requireExecutable } from "@cerium/acp";
import {
  HarnessUnavailable,
  compareVersions,
  type HarnessAdapter,
  type SessionOptions,
} from "@cerium/harness";
import { Context, Effect, Exit, FileSystem, Layer, Path, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/process";

import { makeAntigravityHub } from "./hub.ts";
import {
  INSTALL_HINT,
  MINIMUM_VERSION,
  PROVIDER,
  SIGNED_OUT,
  antigravityHarness,
  antigravityManifest,
  failure,
} from "./manifest.ts";
import {
  connectAntigravity,
  discoverAntigravity,
  findAntigravityExecutable,
  loginRequired,
} from "./probe.ts";
import { antigravityTranslator, startAntigravitySession } from "./session.ts";

/** Defaults to finding the user's `agy` on PATH. A caller may supply its absolute path instead. */
export const makeAntigravityAdapter = (executable?: string) =>
  Effect.gen(function* () {
    const platform = yield* Effect.context<
      ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
    >();
    const fs = yield* FileSystem.FileSystem;
    const hub = yield* makeAntigravityHub();
    const history = Effect.gen(function* () {
      const path = yield* requireExecutable(
        antigravityHarness,
        executable ?? (yield* findAntigravityExecutable),
      );
      const cwd = yield* probeWorkspace(antigravityHarness);
      return yield* connectAntigravity(path, cwd, ["--include-default-customizations=false"]);
    });
    const [kept, forget] = yield* Effect.cachedInvalidateWithTTL(
      discoverAntigravity(executable).pipe(Effect.provide(platform)),
      (exit) =>
        Exit.isSuccess(exit) &&
        exit.value.status._tag === "HarnessInstalled" &&
        exit.value.status.auth._tag === "LoggedIn"
          ? "5 minutes"
          : 0,
    );
    const fresh = Effect.andThen(forget, kept);
    const ready = Effect.gen(function* () {
      let discovery = yield* kept;
      if (
        discovery.status._tag === "HarnessInstalled" &&
        !(yield* fs.exists(discovery.status.executablePath).pipe(Effect.orElseSucceed(() => true)))
      ) {
        discovery = yield* fresh;
      }
      const { status, models } = discovery;
      if (status._tag === "HarnessMissing") {
        return yield* new HarnessUnavailable({
          provider: PROVIDER,
          reason: "notInstalled",
          message: INSTALL_HINT,
        });
      }
      if (compareVersions(status.version, MINIMUM_VERSION) < 0) {
        return yield* new HarnessUnavailable({
          provider: PROVIDER,
          reason: "versionTooOld",
          message: `Antigravity CLI ${MINIMUM_VERSION} or newer is required. Run \`agy update\`.`,
        });
      }
      if (status.auth._tag === "LoggedOut") return yield* loginRequired();
      return { executable: status.executablePath, models };
    });

    return {
      provider: PROVIDER,
      ...hub,
      hubInstructions: {
        files: [
          { path: "AGENTS.md", primary: true },
          { path: "GEMINI.md" },
          { path: ".agents/AGENTS.md" },
          { path: ".agents/GEMINI.md" },
        ],
        folders: [
          { path: ".agents/rules", suffix: ".md" },
          { path: ".agent/rules", suffix: ".md" },
        ],
      },
      manifest: antigravityManifest,
      probe: fresh.pipe(Effect.map(({ status }) => status)),
      listModels: ready.pipe(Effect.map(({ models }) => models)),
      listSessions: history.pipe(
        Effect.flatMap((acp) => listAcpSessions(acp)),
        Effect.scoped,
        Effect.provide(platform),
      ),
      readSession: (session) =>
        history.pipe(
          Effect.flatMap((acp) => readAcpSession(acp, session, antigravityTranslator())),
          Effect.scoped,
          Effect.provide(platform),
        ),
      // ACP exposes neither a tool-free, unsaved completion nor a way to delete a helper session.
      complete: () => Effect.fail(failure("Antigravity does not support private background completions")),
      startSession: (options: SessionOptions) =>
        ready.pipe(
          Effect.flatMap(({ executable }) =>
            startAntigravitySession(executable, options).pipe(Effect.provide(platform)),
          ),
          Effect.tapError((error) =>
            error._tag === "HarnessUnavailable" && error.reason === "loggedOut" ? forget : Effect.void,
          ),
          Effect.map((session) => ({
            ...session,
            events: session.events.pipe(
              Stream.flatMap((event) =>
                event.payload._tag === "AuthRequired"
                  ? Stream.concat(
                      Stream.fromEffect(forget.pipe(Effect.as(event))),
                      Stream.make({
                        payload: {
                          _tag: "AgentError",
                          kind: "unknown",
                          message: SIGNED_OUT,
                          retryable: false,
                        },
                      } as const),
                    )
                  : Stream.make(event),
              ),
            ),
          })),
        ),
    } satisfies HarnessAdapter;
  });

export class AntigravityAdapter extends Context.Service<AntigravityAdapter, HarnessAdapter>()(
  "cerium/adapters/antigravity/AntigravityAdapter",
) {
  /** Requires the platform's ChildProcessSpawner, FileSystem and Path (e.g. NodeServices.layer). */
  static readonly layer = Layer.effect(AntigravityAdapter, makeAntigravityAdapter());
}
