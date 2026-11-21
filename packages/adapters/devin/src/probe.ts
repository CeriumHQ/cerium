import { HarnessUnavailable, findOnPath, parseVersion, scratchFolder } from "@cerium/harness";
import type { HarnessStatus } from "@cerium/protocol";
import { Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { callFailure, connect, needsLogin, record, string, type DevinConnection } from "./acp.ts";
import { INSTALL_HINT, LOGIN_COMMAND, PROVIDER, SIGNED_OUT, failure } from "./manifest.ts";
import { configOption, readConfigOptions, variantOf, type ConfigOption, type Variant } from "./models.ts";

export const findDevinExecutable = findOnPath("devin").pipe(
  Effect.map((paths) => paths.find((path) => process.platform !== "win32" || /\.exe$/i.test(path))),
);

export const loginRequired = () =>
  new HarnessUnavailable({ provider: PROVIDER, reason: "loggedOut", message: SIGNED_OUT });

export interface Discovery {
  readonly status: HarnessStatus;
  /** The options a new session starts with, which hold the account's models. */
  readonly config: ReadonlyArray<ConfigOption>;
}

/** A folder outside any project, so no project's rules or MCP servers load. */
const probeFolder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* scratchFolder(PROVIDER);
  return yield* fs
    .makeTempDirectoryScoped({ directory, prefix: "cerium-devin-" })
    .pipe(Effect.mapError((cause) => failure("Could not prepare Devin's probe workspace", cause)));
});

/** Devin keeps a session from its creation. One that never had a prompt goes with it here. */
const discard = (acp: DevinConnection, sessionId: string) =>
  acp
    .query("session/close", { sessionId })
    .pipe(
      Effect.andThen(acp.query("session/delete", { sessionId })),
      Effect.timeout("5 seconds"),
      Effect.ignore,
    );

const openSession = (acp: DevinConnection, cwd: string) =>
  acp.query("session/new", { cwd, mcpServers: [] }).pipe(
    Effect.flatMap((result) => {
      const sessionId = string(record(result)?.["sessionId"]);
      return sessionId === undefined
        ? Effect.fail(failure("Devin did not open a session"))
        : Effect.succeed({ sessionId, config: readConfigOptions(record(result)?.["configOptions"]) });
    }),
  );

/**
 * `initialize` offers browser sign-in whether or not the CLI is signed in. A session with no prompt
 * tells saved login from ACP's auth_required and returns the account's models in one request.
 */
export const discoverDevin = Effect.fn("Devin.discover")(
  function* (configuredExecutable: string | undefined) {
    const executablePath = configuredExecutable ?? (yield* findDevinExecutable);
    if (executablePath === undefined) {
      return {
        status: { _tag: "HarnessMissing", provider: PROVIDER, installHint: INSTALL_HINT },
        config: [],
      } satisfies Discovery;
    }

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const output = yield* spawner
      .string(ChildProcess.make(executablePath, ["--version"], { stderr: "ignore" }))
      .pipe(
        Effect.mapError((cause) => failure("Could not run `devin --version`", cause)),
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () => Effect.fail(failure("Devin did not report its CLI version")),
        }),
      );
    const version = parseVersion(output);
    if (version === undefined) return yield* failure("Could not read the Devin CLI version");

    const installed = { _tag: "HarnessInstalled", provider: PROVIDER, executablePath, version } as const;
    const cwd = yield* probeFolder;
    const acp = yield* connect(executablePath, cwd);
    const opened = yield* openSession(acp, cwd).pipe(
      Effect.map((session) => ({ signedIn: true as const, ...session })),
      Effect.catchIf(needsLogin, () => Effect.succeed({ signedIn: false as const })),
      Effect.mapError(callFailure("session/new")),
    );
    if (!opened.signedIn) {
      return {
        status: { ...installed, auth: { _tag: "LoggedOut", loginCommand: LOGIN_COMMAND } },
        config: [],
      } satisfies Discovery;
    }
    yield* discard(acp, opened.sessionId);
    if (!configOption(opened.config, "model")?.options.length)
      return yield* failure("Devin returned no models");
    return {
      status: { ...installed, auth: { _tag: "LoggedIn" } },
      config: opened.config,
    } satisfies Discovery;
  },
  Effect.scoped,
  Effect.timeoutOrElse({
    duration: "30 seconds",
    orElse: () => Effect.fail(failure("Devin did not finish its ACP status check")),
  }),
);

/** Sessions the sweep switches models in side by side; each switch is a round trip to Devin's service. */
const SWEEP_SESSIONS = 12;

/**
 * Reads each model's efforts and speeds, which Devin only reports for the model a session is on, by
 * switching models in a few sessions that never take a prompt. Each result is handed to `found` as it
 * comes, so a listing can use what is known before the sweep ends. A model Devin refuses is skipped.
 */
export const sweepVariants = Effect.fn("Devin.sweepVariants")(function* (
  executable: string,
  models: ReadonlyArray<string>,
  found: (model: string, variant: Variant) => void,
) {
  const cwd = yield* probeFolder;
  const acp = yield* connect(executable, cwd);
  const queue = [...models];
  const sweep = (session: { readonly sessionId: string }) =>
    Effect.gen(function* () {
      for (let model = queue.shift(); model !== undefined; model = queue.shift()) {
        const result = yield* acp
          .query("session/set_config_option", {
            sessionId: session.sessionId,
            configId: "model",
            value: model,
          })
          .pipe(Effect.option);
        if (result._tag === "None") continue;
        const config = readConfigOptions(record(result.value)?.["configOptions"]);
        if (configOption(config, "model")?.currentValue === model) found(model, variantOf(config));
      }
    }).pipe(Effect.ensuring(discard(acp, session.sessionId)));
  yield* Effect.forEach(
    Array.from({ length: Math.min(SWEEP_SESSIONS, models.length) }),
    () => openSession(acp, cwd).pipe(Effect.mapError(callFailure("session/new")), Effect.flatMap(sweep)),
    { concurrency: "unbounded", discard: true },
  );
}, Effect.scoped);
