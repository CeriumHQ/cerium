import {
  connect,
  listAcpSessions,
  LiveSessions,
  readAcpSession,
  signedOut,
  startAcpSession,
  type AcpConnection,
} from "@cerium/adapter-acp";
import {
  HarnessFailure,
  HarnessUnavailable,
  scratchFolder,
  shareProbe,
  type HarnessAdapter,
  type SessionOptions,
} from "@cerium/harness";
import type { SkillInfo } from "@cerium/protocol";
import { Context, Effect, FileSystem, Layer, Path, RcRef } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { askAside, listGrokSkills } from "./aside.ts";
import { completeWithGrok } from "./complete.ts";
import { grokHarness, grokOutput, grokToolView } from "./harness.ts";
import { grokManifest, INSTALL_HINT, LOGIN_COMMAND } from "./manifest.ts";
import { lowestEffort, modelStateOf, toModelInfos } from "./models.ts";
import { agentCommand, probeGrok, readAuth } from "./probe.ts";
import { readGrokUsage } from "./usage.ts";

/** How long the shared agent stays up after its last use. */
const SHARED_IDLE = "3 minutes";
/** How long a folder's skills are kept: listing them opens a session. */
const SKILLS_KEPT = 60_000;

const HARNESS = { provider: "grok", label: "Grok Build", loginCommand: LOGIN_COMMAND } as const;

export class GrokAdapter extends Context.Service<GrokAdapter, HarnessAdapter>()(
  "cerium/adapters/grok/GrokAdapter",
) {
  /** Requires the platform's `ChildProcessSpawner`, `FileSystem` and `Path` (e.g. `NodeServices.layer`). */
  static readonly layer = Layer.effect(
    GrokAdapter,
    Effect.gen(function* () {
      // Only these services: the layer's whole context would also carry its Scope, which would then
      // replace the scope a session is started in.
      const platform = Context.pick(
        ChildProcessSpawner.ChildProcessSpawner,
        FileSystem.FileSystem,
        Path.Path,
      )(yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path>());
      const live = new LiveSessions();
      const harness = grokHarness(live);

      // Probing, listing models, skills and sessions, and reading usage talk to one agent, started on
      // first use in a folder of Cerium's own and stopped once nothing has needed it for a while.
      // Sessions start agents of their own.
      let executable = "";
      const scratch = scratchFolder("grok").pipe(Effect.provide(platform));
      const shared = yield* RcRef.make({
        acquire: scratch.pipe(
          Effect.flatMap((cwd) => connect(agentCommand(executable, cwd))),
          Effect.provide(platform),
        ),
        idleTimeToLive: SHARED_IDLE,
      });
      const withAgent = <A, E>(
        executablePath: string,
        use: (connection: AcpConnection) => Effect.Effect<A, E>,
      ) =>
        Effect.gen(function* () {
          // A new install path (an update moved it) needs a new agent.
          if (executable !== executablePath) {
            if (executable !== "") yield* RcRef.invalidate(shared);
            executable = executablePath;
          }
          return yield* use(yield* RcRef.get(shared));
        }).pipe(
          // An agent that failed a call may have stopped; the next call starts a fresh one.
          Effect.tapError(() => RcRef.invalidate(shared)),
          Effect.scoped,
        );

      const probes = yield* shareProbe(
        probeGrok((executablePath) => withAgent(executablePath, readAuth)).pipe(Effect.provide(platform)),
      );

      /** The installed executable, once it is known to be usable. */
      const ready = Effect.gen(function* () {
        const status = yield* probes.kept;
        if (status._tag === "HarnessMissing") {
          return yield* new HarnessUnavailable({
            provider: "grok",
            reason: "notInstalled",
            message: INSTALL_HINT,
          });
        }
        if (status.auth._tag === "LoggedOut") return yield* signedOut(HARNESS);
        return status.executablePath;
      });

      const modelState = (executablePath: string) =>
        withAgent(executablePath, (connection) => Effect.succeed(modelStateOf(connection.initialized)));

      const skills = new Map<string, { readonly at: number; readonly skills: ReadonlyArray<SkillInfo> }>();

      const startSession = Effect.fn("GrokAdapter.startSession")(function* (options: SessionOptions) {
        const executablePath = yield* ready;
        const session = yield* startAcpSession(harness, agentCommand(executablePath), options).pipe(
          Effect.provide(platform),
        );
        return probes.watchSignIn(session, signedOut(HARNESS).message);
      });

      return GrokAdapter.of({
        provider: "grok",
        manifest: grokManifest,
        probe: probes.fresh,
        listModels: ready.pipe(
          Effect.flatMap(modelState),
          Effect.flatMap((state) =>
            state === undefined
              ? Effect.fail(
                  new HarnessFailure({ provider: "grok", message: "Grok listed no models", cause: state }),
                )
              : Effect.succeed(toModelInfos(state)),
          ),
        ),
        listSkills: (cwd) =>
          Effect.gen(function* () {
            const kept = skills.get(cwd);
            if (kept !== undefined && Date.now() - kept.at < SKILLS_KEPT) return kept.skills;
            const executablePath = yield* ready;
            const listed = yield* withAgent(executablePath, (connection) => listGrokSkills(connection, cwd));
            skills.set(cwd, { at: Date.now(), skills: listed });
            return listed;
          }),
        usage: ready.pipe(Effect.flatMap((executablePath) => withAgent(executablePath, readGrokUsage))),
        complete: (request) =>
          Effect.gen(function* () {
            const executablePath = yield* ready;
            const state = yield* modelState(executablePath);
            return yield* completeWithGrok(executablePath, request, lowestEffort(state, request.model)).pipe(
              Effect.provide(platform),
            );
          }),
        sideQuestion: (request) => askAside(live, request),
        listSessions: ready.pipe(
          Effect.flatMap((executablePath) =>
            withAgent(executablePath, (connection) => listAcpSessions(connection, "grok")),
          ),
        ),
        readSession: (session) =>
          Effect.gen(function* () {
            const executablePath = yield* ready;
            const folder = yield* scratch;
            return yield* withAgent(executablePath, (connection) =>
              readAcpSession(connection, session, {
                provider: "grok",
                cwd: session.cwd ?? folder,
                view: grokToolView,
                output: grokOutput,
              }),
            );
          }),
        startSession,
      });
    }),
  );
}
