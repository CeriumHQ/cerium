import {
  HarnessUnavailable,
  compareVersions,
  findOnPath,
  parseVersion,
  scratchFolder,
} from "@cerium/harness";
import type { HarnessStatus, ModelInfo } from "@cerium/protocol";
import { Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { callFailure, connect, needsLogin } from "./acp.ts";
import { INSTALL_HINT, LOGIN_COMMAND, MINIMUM_VERSION, PROVIDER, SIGNED_OUT, failure } from "./manifest.ts";
import { readSessionDetails, toModelInfos } from "./models.ts";

export const findAntigravityExecutable = findOnPath("agy").pipe(
  Effect.map((paths) => paths.find((path) => process.platform !== "win32" || /\.exe$/i.test(path))),
);

export const loginRequired = () =>
  new HarnessUnavailable({ provider: PROVIDER, reason: "loggedOut", message: SIGNED_OUT });

interface Discovery {
  readonly status: HarnessStatus;
  readonly models: ReadonlyArray<ModelInfo>;
}

export const discoverAntigravity = Effect.fn("Antigravity.discover")(function* (
  configuredExecutable: string | undefined,
) {
  const executablePath = configuredExecutable ?? (yield* findAntigravityExecutable);
  if (executablePath === undefined) {
    return {
      status: { _tag: "HarnessMissing", provider: PROVIDER, installHint: INSTALL_HINT },
      models: [],
    } satisfies Discovery;
  }

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* spawner
    .string(ChildProcess.make(executablePath, ["--version"], { stderr: "ignore" }))
    .pipe(
      Effect.mapError((cause) => failure("Could not run `agy --version`", cause)),
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(failure("Antigravity did not report its CLI version")),
      }),
    );
  const version = parseVersion(output);
  if (version === undefined) return yield* failure("Could not read the Antigravity CLI version");

  const installed = { _tag: "HarnessInstalled", provider: PROVIDER, executablePath, version } as const;
  const loggedOut = { _tag: "LoggedOut", loginCommand: LOGIN_COMMAND } as const;
  if (compareVersions(version, MINIMUM_VERSION) < 0) {
    return {
      status: {
        ...installed,
        auth: loggedOut,
        versionStatus: "tooOld",
        updateCommand: "agy update",
        limit: {
          blocks: ["readOnly", "ask", "acceptEdits", "auto", "fullAccess"],
          reason: `Antigravity CLI ${MINIMUM_VERSION} or newer is required for ACP.`,
        },
      },
      models: [],
    } satisfies Discovery;
  }

  // `initialize` offers authentication methods regardless of login state. A session with no prompt
  // distinguishes saved login from -32000 and returns the account's model catalog in one request.
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* scratchFolder(PROVIDER);
  const cwd = yield* fs
    .makeTempDirectoryScoped({ directory, prefix: "cerium-antigravity-" })
    .pipe(Effect.mapError((cause) => failure("Could not prepare Antigravity's probe workspace", cause)));
  const acp = yield* connect(executablePath, cwd, ["--include-default-customizations=false"]);
  const result = yield* acp.query("session/new", { cwd, mcpServers: [] }).pipe(
    Effect.map((value) => ({ signedIn: true as const, value })),
    Effect.catchIf(needsLogin, () => Effect.succeed({ signedIn: false as const })),
    Effect.mapError(callFailure("session/new")),
  );
  if (!result.signedIn) {
    return { status: { ...installed, auth: loggedOut }, models: [] } satisfies Discovery;
  }

  const details = yield* readSessionDetails(result.value).pipe(
    Effect.mapError(() => failure("Antigravity returned an invalid model catalog")),
  );
  yield* acp
    .query("session/close", { sessionId: details.sessionId })
    .pipe(Effect.mapError(callFailure("session/close")));
  const models = toModelInfos(details);
  if (models.length === 0) return yield* failure("Antigravity returned no models");

  const modes = details.configOptions.find(({ id }) => id === "mode")?.options;
  const hasAuto = modes?.some(({ value }) => value === "auto") === true;
  return {
    status: {
      ...installed,
      auth: { _tag: "LoggedIn" },
      limit: {
        blocks: hasAuto ? ["readOnly"] : ["readOnly", "auto"],
        reason: hasAuto
          ? "Antigravity does not provide a verified read-only mode."
          : "Antigravity does not provide a verified read-only mode or offer Auto mode on this account.",
      },
    },
    models,
  } satisfies Discovery;
}, Effect.scoped);

export const probeAntigravity = discoverAntigravity(undefined).pipe(Effect.map(({ status }) => status));
