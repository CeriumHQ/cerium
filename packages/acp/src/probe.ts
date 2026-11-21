import { findOnPath, parseVersion, scratchFolder } from "@cerium/harness";
import { Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { harnessFailure, type AcpHarness } from "./harness.ts";

/** The harness's executable on PATH. On Windows only an `.exe` runs as a subprocess without a shell. */
export const findExecutable = (command: string) =>
  findOnPath(command).pipe(
    Effect.map((paths) => paths.find((path) => process.platform !== "win32" || /\.exe$/i.test(path))),
  );

/** The CLI's version, from `<command> --version`. */
export const readCliVersion = Effect.fn("Acp.readCliVersion")(function* (
  harness: AcpHarness,
  executable: string,
  command: string,
) {
  const failure = harnessFailure(harness);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* spawner
    .string(ChildProcess.make(executable, ["--version"], { stderr: "ignore" }))
    .pipe(
      Effect.mapError((cause) => failure(`Could not run \`${command} --version\``, cause)),
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(failure(`${harness.label} did not report its CLI version`)),
      }),
    );
  const version = parseVersion(output);
  if (version === undefined) return yield* failure(`Could not read the ${harness.label} CLI version`);
  return version;
});

/**
 * An empty folder outside any project for a probe's session, so no project's rules or MCP servers
 * load. It goes when the scope closes.
 */
export const probeWorkspace = Effect.fn("Acp.probeWorkspace")(function* (harness: AcpHarness) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* scratchFolder(harness.provider);
  return yield* fs
    .makeTempDirectoryScoped({ directory, prefix: `cerium-${harness.provider}-` })
    .pipe(
      Effect.mapError((cause) =>
        harnessFailure(harness)(`Could not prepare ${harness.label}'s probe workspace`, cause),
      ),
    );
});
