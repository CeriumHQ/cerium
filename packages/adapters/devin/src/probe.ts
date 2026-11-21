import {
  configOption,
  connect,
  findExecutable,
  loginRequired as acpLoginRequired,
  needsLogin,
  probeWorkspace,
  readCliVersion,
  readConfigOptions,
  record,
  string,
  type AcpConnection,
  type ConfigOption,
} from "@cerium/acp";
import type { HarnessStatus } from "@cerium/protocol";
import { Effect } from "effect";

import { INSTALL_HINT, LOGIN_COMMAND, PROVIDER, devinHarness, failure } from "./manifest.ts";
import { variantOf, type Variant } from "./models.ts";

export const findDevinExecutable = findExecutable("devin");

export const loginRequired = () => acpLoginRequired(devinHarness);

/**
 * `devin acp` over stdio. The agent runs in this process rather than in the daemon the user's own
 * `devin` commands share, so closing the scope ends it.
 */
export const connectDevin = (executable: string, cwd: string, configFile?: string) =>
  connect(devinHarness, {
    executable,
    args: [
      ...(configFile === undefined ? [] : ["--config", configFile]),
      "acp",
      "--process-model",
      "in-process",
    ],
    cwd,
  });

export interface Discovery {
  readonly status: HarnessStatus;
  /** The options a new session starts with, which hold the account's models. */
  readonly config: ReadonlyArray<ConfigOption>;
}

/** Devin keeps a session from its creation. One that never had a prompt goes with it here. */
const discard = (acp: AcpConnection, sessionId: string) =>
  acp
    .query("session/close", { sessionId })
    .pipe(
      Effect.andThen(acp.query("session/delete", { sessionId })),
      Effect.timeout("5 seconds"),
      Effect.ignore,
    );

const openSession = (acp: AcpConnection, cwd: string) =>
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

    const version = yield* readCliVersion(devinHarness, executablePath, "devin");
    const installed = { _tag: "HarnessInstalled", provider: PROVIDER, executablePath, version } as const;
    const cwd = yield* probeWorkspace(devinHarness);
    const acp = yield* connectDevin(executablePath, cwd);
    const opened = yield* openSession(acp, cwd).pipe(
      Effect.map((session) => ({ signedIn: true as const, ...session })),
      Effect.catchIf(needsLogin, () => Effect.succeed({ signedIn: false as const })),
      Effect.mapError(acp.refused("session/new")),
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
  const cwd = yield* probeWorkspace(devinHarness);
  const acp = yield* connectDevin(executable, cwd);
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
    () => openSession(acp, cwd).pipe(Effect.mapError(acp.refused("session/new")), Effect.flatMap(sweep)),
    { concurrency: "unbounded", discard: true },
  );
}, Effect.scoped);
