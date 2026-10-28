import { findOnPath, HarnessFailure, parseVersion } from "@cerium/harness";
import type { AuthStatus, HarnessStatus } from "@cerium/protocol";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { INSTALL_HINT, LOGIN_COMMAND } from "./manifest.ts";

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "claude", message, cause });

/** The subset of `claude auth status --json` Cerium reads. Identity fields are never decoded. */
const CliAuthStatus = Schema.Struct({
  loggedIn: Schema.Boolean,
  authMethod: Schema.optionalKey(Schema.String),
  subscriptionType: Schema.optionalKey(Schema.String),
});
const decodeCliAuthStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(CliAuthStatus));

/**
 * Finds the user's installed `claude`. Windows npm installs put a `.cmd` shim on PATH; the SDK needs
 * the real executable (or the JS entry point) behind it.
 */
export const findClaudeExecutable = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const windows = process.platform === "win32";

  const candidates = yield* findOnPath("claude");

  for (const candidate of candidates) {
    const extension = path.extname(candidate).toLowerCase();
    if (!windows || extension === ".exe") return Option.some(candidate);
    if (extension === ".cmd" || extension === "") {
      const packageDir = path.join(path.dirname(candidate), "node_modules", "@anthropic-ai", "claude-code");
      for (const entry of [path.join(packageDir, "bin", "claude.exe"), path.join(packageDir, "cli.js")]) {
        if (yield* fs.exists(entry).pipe(Effect.orElseSucceed(() => false))) return Option.some(entry);
      }
    }
  }
  return Option.none<string>();
});

export const probeClaude = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const executable = yield* findClaudeExecutable;
  if (Option.isNone(executable)) {
    return { _tag: "HarnessMissing", provider: "claude", installHint: INSTALL_HINT } satisfies HarnessStatus;
  }

  const versionOutput = yield* spawner
    .string(ChildProcess.make(executable.value, ["--version"]))
    .pipe(Effect.mapError(failure("Could not run `claude --version`")));
  const version = parseVersion(versionOutput);
  if (version === undefined) {
    return yield* new HarnessFailure({
      provider: "claude",
      message: "Could not read the Claude Code version",
      cause: versionOutput,
    });
  }

  const authOutput = yield* spawner
    .string(ChildProcess.make(executable.value, ["auth", "status", "--json"]))
    .pipe(Effect.mapError(failure("Could not run `claude auth status`")));
  const cliAuth = yield* decodeCliAuthStatus(authOutput.trim()).pipe(
    Effect.mapError(failure("Unexpected `claude auth status` output")),
  );

  const auth: AuthStatus = cliAuth.loggedIn
    ? {
        _tag: "LoggedIn",
        ...(cliAuth.authMethod ? { method: cliAuth.authMethod } : {}),
        ...(cliAuth.subscriptionType ? { plan: cliAuth.subscriptionType } : {}),
      }
    : { _tag: "LoggedOut", loginCommand: LOGIN_COMMAND };

  return {
    _tag: "HarnessInstalled",
    provider: "claude",
    executablePath: executable.value,
    version,
    auth,
  } satisfies HarnessStatus;
});
