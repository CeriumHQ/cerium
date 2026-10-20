import { classifyVersion, HarnessFailure, parseVersion } from "@cerium/harness";
import type { AuthStatus, HarnessStatus } from "@cerium/protocol";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { call, type OpenCodeClient } from "./host.ts";
import { INSTALL_HINT, LOGIN_COMMAND, opencodeManifest } from "./manifest.ts";
import { ModelList } from "./models.ts";

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "opencode", message, cause });

/** The package npm and Bun install, whose `bin/opencode.exe` is the native binary itself. */
const PACKAGE_BINARY = ["node_modules", "@opencode", "cli", "bin", "opencode.exe"] as const;

/**
 * The binary a Bun shim (`opencode.exe` beside `opencode.bunx`) starts: the `.bunx` file holds its
 * path in UTF-16, relative to Bun's folder and ended by a quote.
 */
export const bunShimTarget = (shim: Uint8Array): string | undefined => {
  const text = new TextDecoder("utf-16le").decode(shim);
  const end = text.indexOf('"');
  const target = end <= 0 ? undefined : text.slice(0, end);
  return target !== undefined && /\.exe$/i.test(target) ? target : undefined;
};

/**
 * Finds the user's installed `opencode`. The installer and package managers put it on PATH as the
 * binary itself, an npm `.cmd` shim, or a Bun shim executable; shims resolve to the binary they start,
 * so stopping Cerium's server stops OpenCode itself.
 */
export const findOpenCodeExecutable = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const windows = process.platform === "win32";
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));

  const candidates = yield* spawner
    .lines(
      windows ? ChildProcess.make("where", ["opencode"]) : ChildProcess.make("which", ["-a", "opencode"]),
    )
    .pipe(
      Effect.map((lines) => lines.map((line) => line.trim()).filter((line) => line !== "")),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );

  for (const candidate of candidates) {
    if (!windows) return Option.some(candidate);
    const extension = path.extname(candidate).toLowerCase();
    const directory = path.dirname(candidate);
    if (extension === ".exe") {
      const shim = `${candidate.slice(0, -extension.length)}.bunx`;
      if (yield* exists(shim)) {
        const target = bunShimTarget(
          yield* fs.readFile(shim).pipe(Effect.orElseSucceed(() => new Uint8Array())),
        );
        const binary = target === undefined ? undefined : path.resolve(path.dirname(directory), target);
        if (binary !== undefined && (yield* exists(binary))) return Option.some(binary);
      }
      return Option.some(candidate);
    }
    if (extension === ".cmd" || extension === ".ps1" || extension === "") {
      const binary = path.join(directory, ...PACKAGE_BINARY);
      if (yield* exists(binary)) return Option.some(binary);
    }
  }
  return Option.none<string>();
});

/** What `integration.list` says Cerium reads: which integrations have a connection, never its label. */
const Integrations = Schema.Struct({
  data: Schema.Array(Schema.Struct({ name: Schema.String, connections: Schema.Array(Schema.Unknown) })),
});
const decodeIntegrations = Schema.decodeUnknownEffect(Integrations);
const decodeModels = Schema.decodeUnknownEffect(ModelList);

/** The method a session runs on when no provider is connected: OpenCode Zen's free models. */
export const FREE_MODELS = "opencodeFree";

/**
 * Whether OpenCode can run a model: it lists the models its connected providers (and OpenCode Zen's
 * free models) offer. The method names the connected integrations, read from their status alone.
 */
export const readAuth = Effect.fn("OpenCodeAdapter.readAuth")(function* (client: OpenCodeClient) {
  const [models, integrations] = yield* Effect.all(
    [
      call("list its models", (signal) => client.model.list(undefined, { signal })),
      call("list its integrations", (signal) => client.integration.list(undefined, { signal })),
    ],
    { concurrency: 2 },
  );
  const { data: rows } = yield* decodeModels(models).pipe(
    Effect.mapError(failure("Unexpected `model.list` response")),
  );
  const { data } = yield* decodeIntegrations(integrations).pipe(
    Effect.mapError(failure("Unexpected `integration.list` response")),
  );
  if (!rows.some((row) => row.enabled)) {
    return { _tag: "LoggedOut", loginCommand: LOGIN_COMMAND } satisfies AuthStatus;
  }
  const connected = data.filter((integration) => integration.connections.length > 0).map(({ name }) => name);
  return {
    _tag: "LoggedIn",
    method: connected.length > 0 ? connected.join(", ") : FREE_MODELS,
  } satisfies AuthStatus;
});

/** Probes with `auth`, which reads the sign-in from a server the adapter shares between calls. */
export const probeOpenCode = (auth: (executablePath: string) => Effect.Effect<AuthStatus, HarnessFailure>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const executable = yield* findOpenCodeExecutable;
    if (Option.isNone(executable)) {
      return {
        _tag: "HarnessMissing",
        provider: "opencode",
        installHint: INSTALL_HINT,
      } satisfies HarnessStatus;
    }
    const output = yield* spawner
      .string(ChildProcess.make(executable.value, ["--version"]))
      .pipe(Effect.mapError(failure("Could not run `opencode --version`")));
    const version = parseVersion(output);
    if (version === undefined) {
      return yield* new HarnessFailure({
        provider: "opencode",
        message: "Could not read the OpenCode version",
        cause: output,
      });
    }
    const versionStatus = classifyVersion(version, opencodeManifest.harnessVersion);
    return {
      _tag: "HarnessInstalled",
      provider: "opencode",
      executablePath: executable.value,
      version,
      versionStatus,
      // OpenCode 1 serves another API, so its sign-in can't be read; updating comes first anyway.
      auth:
        versionStatus === "tooOld"
          ? { _tag: "LoggedOut", loginCommand: LOGIN_COMMAND }
          : yield* auth(executable.value),
    } satisfies HarnessStatus;
  });
