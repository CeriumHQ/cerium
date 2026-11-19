import { findOnPath, HarnessFailure, parseVersion } from "@cerium/harness";
import type { AuthStatus } from "@cerium/protocol";
import { Effect, FileSystem, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { LOGIN_COMMAND } from "./manifest.ts";
import { failure, record, type CopilotHost } from "./rpc.ts";

export const findCopilotExecutable = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const candidates = yield* findOnPath("copilot");
  for (const candidate of candidates) {
    if (process.platform !== "win32" || path.extname(candidate).toLowerCase() === ".exe") return candidate;
    // npm's .cmd shim requires a shell. Use the same installed native binary directly.
    const modules = path.join(path.dirname(candidate), "node_modules");
    const platformPackage = `copilot-win32-${process.arch}`;
    for (const parent of [modules, path.join(modules, "@github", "copilot", "node_modules")]) {
      const binary = path.join(parent, "@github", platformPackage, "copilot.exe");
      if (yield* fs.exists(binary).pipe(Effect.orElseSucceed(() => false))) return binary;
    }
  }
  return undefined;
});

export const readVersion = Effect.fn("CopilotAdapter.readVersion")(function* (executable: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* spawner.string(ChildProcess.make(executable, ["--version", "--no-auto-update"])).pipe(
    Effect.mapError(failure("Could not check the GitHub Copilot CLI version")),
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(failure("GitHub Copilot CLI did not report its version")(undefined)),
    }),
  );
  const version = parseVersion(output);
  return version ?? (yield* failure("Could not read the GitHub Copilot CLI version")(undefined));
});

export const readAuth = (host: CopilotHost) =>
  host.request("auth.getStatus").pipe(
    Effect.flatMap((result): Effect.Effect<AuthStatus, HarnessFailure> => {
      const status = record(result);
      if (status?.["isAuthenticated"] === true) return Effect.succeed({ _tag: "LoggedIn" });
      if (status?.["isAuthenticated"] === false) {
        return Effect.succeed({ _tag: "LoggedOut", loginCommand: LOGIN_COMMAND });
      }
      return Effect.fail(failure("GitHub Copilot CLI returned an invalid sign-in status")(undefined));
    }),
  );
