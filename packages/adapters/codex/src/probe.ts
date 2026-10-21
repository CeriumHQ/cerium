import { HarnessFailure, parseVersion } from "@cerium/harness";
import type { AuthStatus, HarnessStatus } from "@cerium/protocol";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { INSTALL_HINT, LOGIN_COMMAND } from "./manifest.ts";
import { connect } from "./rpc.ts";

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "codex", message, cause });

/** The subset of `account/read` Cerium reads. Identity fields (the account email) are never decoded. */
const AccountStatus = Schema.Struct({
  account: Schema.NullOr(
    Schema.Struct({ type: Schema.String, planType: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
  ),
  requiresOpenaiAuth: Schema.Boolean,
});
const decodeAccountStatus = Schema.decodeUnknownEffect(AccountStatus);

/** npm's per-CPU packages holding the native binary behind the `codex.cmd` shim. */
const NPM_BINARIES = [
  ["@openai/codex-win32-x64", "x86_64-pc-windows-msvc"],
  ["@openai/codex-win32-arm64", "aarch64-pc-windows-msvc"],
] as const;

/**
 * Finds the user's installed `codex`. The standalone installer puts `codex.exe` on PATH; npm installs
 * put a `.cmd` shim there instead, with the real executable inside the package.
 */
export const findCodexExecutable = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const windows = process.platform === "win32";

  const candidates = yield* spawner
    .lines(windows ? ChildProcess.make("where", ["codex"]) : ChildProcess.make("which", ["-a", "codex"]))
    .pipe(
      Effect.map((lines) => lines.map((line) => line.trim()).filter((line) => line !== "")),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );

  for (const candidate of candidates) {
    const extension = path.extname(candidate).toLowerCase();
    if (!windows || extension === ".exe") return Option.some(candidate);
    if (extension === ".cmd" || extension === "") {
      const packageDir = path.join(path.dirname(candidate), "node_modules", "@openai", "codex");
      const binaries = NPM_BINARIES.flatMap(([platformPackage, triple]) => {
        const relative = path.join("vendor", triple, "codex", "codex.exe");
        return [
          path.join(packageDir, relative),
          path.join(packageDir, "node_modules", platformPackage, relative),
          path.join(path.dirname(candidate), "node_modules", platformPackage, relative),
        ];
      });
      for (const binary of binaries) {
        if (yield* fs.exists(binary).pipe(Effect.orElseSucceed(() => false))) return Option.some(binary);
      }
    }
  }
  return Option.none<string>();
});

/** Login state from the app-server, which reports the plan without starting a thread. */
const readAuth = Effect.fn("CodexAdapter.readAuth")(function* (executablePath: string) {
  const server = yield* connect(executablePath);
  const response = yield* server
    .request("account/read", {})
    .pipe(Effect.mapError(failure("Could not read the Codex login state")));
  const { account, requiresOpenaiAuth } = yield* decodeAccountStatus(response).pipe(
    Effect.mapError(failure("Unexpected `account/read` response")),
  );
  const plan = account?.planType && account.planType !== "unknown" ? account.planType : undefined;
  const auth: AuthStatus =
    account !== null
      ? { _tag: "LoggedIn", method: account.type, ...(plan ? { plan } : {}) }
      : requiresOpenaiAuth
        ? { _tag: "LoggedOut", loginCommand: LOGIN_COMMAND }
        : // Providers that need no OpenAI login (e.g. a local model provider) report no account.
          { _tag: "LoggedIn" };
  return auth;
}, Effect.scoped);

export const probeCodex = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const executable = yield* findCodexExecutable;
  if (Option.isNone(executable)) {
    return { _tag: "HarnessMissing", provider: "codex", installHint: INSTALL_HINT } satisfies HarnessStatus;
  }

  const versionOutput = yield* spawner
    .string(ChildProcess.make(executable.value, ["--version"]))
    .pipe(Effect.mapError(failure("Could not run `codex --version`")));
  const version = parseVersion(versionOutput);
  if (version === undefined) {
    return yield* new HarnessFailure({
      provider: "codex",
      message: "Could not read the Codex version",
      cause: versionOutput,
    });
  }

  return {
    _tag: "HarnessInstalled",
    provider: "codex",
    executablePath: executable.value,
    version,
    auth: yield* readAuth(executable.value),
  } satisfies HarnessStatus;
});
