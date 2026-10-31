import { openAcpAgent, type InitializeResponse } from "@cerium/adapter-acp";
import { findOnPath, HarnessFailure, parseVersion, scratchFolder } from "@cerium/harness";
import type { HarnessSetup, HarnessStatus } from "@cerium/protocol";
import { Effect, FileSystem, Option, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { homedir } from "node:os";

import { grokAuthMethod, grokHarness } from "./harness.ts";
import { INSTALL_HINT, LOGIN_COMMAND } from "./manifest.ts";

/**
 * Grok's read-only sandbox on Linux runs commands in bubblewrap; without `bwrap` a read-only session
 * refuses to start ("this sandbox could not enforce its deny list on Linux", seen live in 1.0.70).
 */
export const BUBBLEWRAP_SETUP: HarnessSetup = {
  name: "Read-only sandbox",
  reason: "Grok Build's read-only sandbox needs bubblewrap, which isn't installed.",
  command: "apt install -y bubblewrap",
  elevated: true,
  blocks: ["readOnly"],
};

/** The setup Grok's sandbox still needs on this machine, if any. */
const sandboxSetup = Effect.gen(function* () {
  if (process.platform !== "linux") return undefined;
  const found = yield* findOnPath("bwrap");
  return found.length === 0 ? BUBBLEWRAP_SETUP : undefined;
});

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "grok", message, cause });

/**
 * The user's `grok`: the first on PATH, else where xAI's installer and npm's global prefix commonly put
 * it, which a GUI app's PATH may leave out.
 */
export const findGrokExecutable = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const windows = process.platform === "win32";
  const onPath = yield* findOnPath(windows ? "grok.exe" : "grok");
  const candidates = [
    ...onPath,
    ...(windows
      ? []
      : [path.join(homedir(), ".grok", "bin", "grok"), path.join(homedir(), ".local", "bin", "grok")]),
  ];
  for (const candidate of candidates) {
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return Option.some(candidate);
  }
  return Option.none<string>();
});

/** The version `grok --version` prints ("grok 1.0.70"), else the agent's own in `initialize`. */
const readVersion = (executable: string, initialized: InitializeResponse | undefined) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const printed = yield* spawner.string(ChildProcess.make(executable, ["--version"])).pipe(
      Effect.timeout("15 seconds"),
      Effect.orElseSucceed(() => ""),
    );
    const advertised = initialized?._meta?.["agentVersion"];
    return (
      parseVersion(printed) ??
      (typeof advertised === "string" ? parseVersion(advertised) : undefined) ??
      initialized?.agentInfo?.version
    );
  });

/**
 * Finds Grok Build and reads its sign-in the way a session would meet it: an agent process completes
 * `initialize` and the `authenticate` its default method needs. No session is opened and nothing is
 * spent.
 */
export const probeGrok = Effect.gen(function* () {
  const executable = yield* findGrokExecutable;
  if (Option.isNone(executable)) {
    return { _tag: "HarnessMissing", provider: "grok", installHint: INSTALL_HINT } satisfies HarnessStatus;
  }
  const cwd = yield* scratchFolder("grok", "acp");
  const agent = yield* openAcpAgent(grokHarness, executable.value, {
    purpose: "probe",
    cwd,
    access: "readOnly",
    includeUserMcpServers: false,
    injectedMcpServers: [],
  }).pipe(Effect.scoped, Effect.result);
  const initialized = agent._tag === "Success" ? agent.success.connection.initialized : undefined;
  const version = yield* readVersion(executable.value, initialized);
  if (version === undefined) {
    return yield* failure("Could not read the Grok Build version")(executable.value);
  }
  if (agent._tag === "Failure") {
    // Its own words say why (a sandbox it can't enforce, a config it refuses).
    return yield* agent.failure;
  }
  const method = grokAuthMethod(agent.success.connection.initialized);
  const setup = yield* sandboxSetup;
  return {
    _tag: "HarnessInstalled",
    provider: "grok",
    executablePath: executable.value,
    version,
    auth: agent.success.signedIn
      ? { _tag: "LoggedIn", ...(method === undefined ? {} : { method }) }
      : { _tag: "LoggedOut", loginCommand: LOGIN_COMMAND },
    ...(setup === undefined ? {} : { setup }),
  } satisfies HarnessStatus;
});
