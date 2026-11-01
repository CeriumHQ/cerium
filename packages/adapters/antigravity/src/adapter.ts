import {
  connect,
  listAcpSessions,
  negotiatedManifest,
  readAcpSession,
  startAcpSession,
  type AcpConnection,
} from "@cerium/adapter-acp";
import {
  HarnessFailure,
  HarnessUnavailable,
  scratchFolder,
  shareProbe,
  type HarnessAdapter,
} from "@cerium/harness";
import { Context, Effect, FileSystem, Layer, Path, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { antigravityHarness, antigravityToolView } from "./harness.ts";
import { antigravityManifest, INSTALL_HINT } from "./manifest.ts";
import { listAntigravityModels } from "./models.ts";
import { agentCommand, checkUserMcp, loginAntigravity, probeAntigravity } from "./probe.ts";
import { listAntigravitySkills } from "./skills.ts";

export class AntigravityAdapter extends Context.Service<AntigravityAdapter, HarnessAdapter>()(
  "cerium/adapters/antigravity/AntigravityAdapter",
) {
  static readonly layer = Layer.effect(
    AntigravityAdapter,
    Effect.gen(function* () {
      const platform = Context.pick(
        ChildProcessSpawner.ChildProcessSpawner,
        FileSystem.FileSystem,
        Path.Path,
      )(yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path>());
      const scratch = yield* scratchFolder("antigravity", "cerium-antigravity").pipe(
        Effect.provide(platform),
      );
      let manifest = antigravityManifest;
      const probes = yield* shareProbe(
        probeAntigravity(scratch, (initialized) => {
          manifest = negotiatedManifest(antigravityManifest, initialized);
        }).pipe(Effect.provide(platform)),
      );
      const ready = probes.kept.pipe(
        Effect.flatMap((status) => {
          if (status._tag === "HarnessMissing")
            return Effect.fail(
              new HarnessUnavailable({
                provider: "antigravity",
                reason: "notInstalled",
                message: INSTALL_HINT,
              }),
            );
          if (status.auth._tag === "LoggedOut")
            return Effect.fail(
              new HarnessUnavailable({
                provider: "antigravity",
                reason: "loggedOut",
                message:
                  "Sign in to Antigravity in Settings → Harnesses. Its official ACP runtime signs in separately from agy.",
              }),
            );
          return Effect.succeed(status.executablePath);
        }),
      );
      const withAgent = <A, E>(use: (connection: AcpConnection) => Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          const executable = yield* ready;
          return yield* use(yield* connect({ ...agentCommand(executable), cwd: scratch }));
        }).pipe(Effect.scoped, Effect.provide(platform));
      return AntigravityAdapter.of({
        provider: "antigravity",
        get manifest() {
          return manifest;
        },
        probe: probes.fresh,
        login: loginAntigravity.pipe(Stream.provide(platform)),
        listModels: withAgent((connection) => listAntigravityModels(connection, scratch)),
        listSkills: (cwd) => ready.pipe(Effect.andThen(listAntigravitySkills(cwd)), Effect.provide(platform)),
        // ACP exposes neither a tool-free transient prompt nor a session delete method. Starting a
        // regular session and promising it saves nothing would violate complete()'s contract.
        complete: () =>
          Effect.fail(
            new HarnessFailure({
              provider: "antigravity",
              message:
                "Antigravity ACP has no tool-free, unsaved completion mode. Choose another harness for Cerium's small jobs.",
              cause: undefined,
            }),
          ),
        listSessions: withAgent((connection) =>
          listAcpSessions(connection, "antigravity").pipe(
            Effect.map((sessions) => sessions.filter((session) => session.cwd !== scratch)),
          ),
        ),
        readSession: (session) =>
          withAgent((connection) =>
            readAcpSession(connection, session, {
              provider: "antigravity",
              cwd: session.cwd ?? scratch,
              view: antigravityToolView,
            }),
          ),
        startSession: (options) =>
          Effect.gen(function* () {
            const executable = yield* ready;
            yield* checkUserMcp(options.includeUserMcpServers);
            const session = yield* startAcpSession(antigravityHarness, agentCommand(executable), options);
            return probes.watchSignIn(session, "Antigravity needs sign-in in Settings → Harnesses.");
          }).pipe(Effect.provide(platform)),
      });
    }),
  );
}
