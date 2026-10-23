import { HarnessFailure, parseVersion } from "@cerium/harness";
import type { AuthStatus, HarnessStatus } from "@cerium/protocol";
import { MspError } from "@muse-code/sdk";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { openHost, query, type MuseHost } from "./host.ts";
import { INSTALL_HINT, LOGIN_COMMAND } from "./manifest.ts";
import { sandboxLimit, sandboxProblem, sandboxSetup } from "./policy.ts";

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "muse", message, cause });

/** The launcher's own pattern for the active release recorded in `.muse-version`. */
const RELEASE = /^[0-9]+\.[0-9]+\.[0-9]+-R[0-9]+(\.[0-9]+)?$/;

/**
 * Finds the user's installed Muse Code binary. The `muse` on PATH is a launcher (on Windows a `.cmd` that
 * runs a PowerShell script) that auto-updates and then runs `muse-bin-<release>` beside it; MSP needs that
 * binary's own stdio, so it is resolved from the launcher's `.muse-version`.
 */
export const findMuseExecutable = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const windows = process.platform === "win32";

  const candidates = yield* spawner
    .lines(windows ? ChildProcess.make("where", ["muse"]) : ChildProcess.make("which", ["-a", "muse"]))
    .pipe(
      Effect.map((lines) => lines.map((line) => line.trim()).filter((line) => line !== "")),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );

  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  for (const candidate of candidates) {
    const directory = path.dirname(candidate);
    const release = yield* fs.readFileString(path.join(directory, ".muse-version")).pipe(
      Effect.map((text) => text.trim()),
      Effect.orElseSucceed(() => ""),
    );
    if (RELEASE.test(release)) {
      const binary = path.join(directory, `muse-bin-${release}${windows ? ".exe" : ""}`);
      if (yield* exists(binary)) return Option.some(binary);
    }
    const extension = path.extname(candidate).toLowerCase();
    if (!windows || extension === ".exe") return Option.some(candidate);
  }
  return Option.none<string>();
});

/** The subset of the `account/read` result Cerium reads. The display label is never decoded. */
const AccountState = Schema.Struct({ state: Schema.String, credentialRequired: Schema.Boolean });
const UsageRead = Schema.Struct({ usage: Schema.optionalKey(Schema.Struct({ tier: Schema.String })) });

/** Method names the settings view already knows, where one fits. */
const METHODS: Record<string, string> = { accountLogin: "meta.ai", apiKey: "apiKey", envKey: "apiKey" };

/**
 * Asks a throwaway host what sessions would find: the login state, from MSP's `account/read` (the
 * credential lane in effect, never the credential), and whether it can sandbox commands, from its
 * handshake. `account/read` is experimental, so when a host stops serving it the probe reports signed in
 * and a session's `authRequired` turn failure surfaces the problem instead.
 */
export const readMuseHost = Effect.fn("MuseAdapter.readHost")(function* (executablePath: string) {
  const host = yield* openHost(executablePath, ["serve", "--no-session-log"], {
    capabilities: { experimentalApi: true, userInputDialogs: false },
  });
  return {
    auth: yield* readAuth(host),
    // An older host leaves it out, which reads as a sandbox that works.
    sandboxUnavailable: host.spawned.initializeResult.sandboxAvailability === "unavailable",
  };
}, Effect.scoped);

const readAuth = Effect.fn("MuseAdapter.readAuth")(function* (host: MuseHost) {
  const account = yield* query(host, "account/read").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AccountState)),
    Effect.asSome,
    Effect.catch((error) =>
      error instanceof HarnessFailure && error.cause instanceof MspError
        ? Effect.logWarning("Muse Code no longer serves account/read", error.cause.message).pipe(
            Effect.as(Option.none<typeof AccountState.Type>()),
          )
        : Effect.fail(failure("Unexpected `account/read` answer from Muse Code")(error)),
    ),
  );
  // The subscription tier is only known once the host has seen a usage window; absent is fine.
  const tier = yield* query(host, "usage/read").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(UsageRead)),
    Effect.map((read) => read.usage?.tier),
    Effect.orElseSucceed(() => undefined),
  );
  const plan = tier ? { plan: tier } : {};
  if (Option.isNone(account)) return { _tag: "LoggedIn", ...plan } satisfies AuthStatus;
  const { state, credentialRequired } = account.value;
  if (state === "loggedOut" && credentialRequired) {
    return { _tag: "LoggedOut", loginCommand: LOGIN_COMMAND } satisfies AuthStatus;
  }
  const method = METHODS[state];
  return { _tag: "LoggedIn", ...(method ? { method } : {}), ...plan } satisfies AuthStatus;
});

export const probeMuse = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const executable = yield* findMuseExecutable;
  if (Option.isNone(executable)) {
    return { _tag: "HarnessMissing", provider: "muse", installHint: INSTALL_HINT } satisfies HarnessStatus;
  }

  // "Muse Code 1.4.10 (1.4.10-R6427.1)"
  const versionOutput = yield* spawner
    .string(ChildProcess.make(executable.value, ["--version"]))
    .pipe(Effect.mapError(failure("Could not run `muse --version`")));
  const version = parseVersion(versionOutput);
  if (version === undefined) {
    return yield* new HarnessFailure({
      provider: "muse",
      message: "Could not read the Muse Code version",
      cause: versionOutput,
    });
  }

  const setup = process.platform === "win32" ? yield* checkWindowsSandbox(executable.value) : undefined;
  const host = yield* readMuseHost(executable.value);
  return {
    _tag: "HarnessInstalled",
    provider: "muse",
    executablePath: executable.value,
    version,
    auth: host.auth,
    ...(setup === undefined ? {} : { setup }),
    // A sandbox that still needs its setup says so; one that is set up and still can't run is a limit.
    ...(setup === undefined && host.sandboxUnavailable ? { limit: sandboxLimit } : {}),
  } satisfies HarnessStatus;
});

/**
 * Muse's own `sandbox windows check` (about 0.1 s): the setup its sandbox still needs, if any. Trouble
 * asking reads as nothing to do, so the check never keeps Muse from starting.
 */
const checkWindowsSandbox = (executable: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const problem = sandboxProblem(
      yield* spawner.string(ChildProcess.make(executable, ["sandbox", "windows", "check"])),
    );
    return problem === undefined ? undefined : sandboxSetup(problem);
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() => undefined),
  );
