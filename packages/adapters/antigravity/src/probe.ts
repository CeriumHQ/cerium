import { findOnPath, HarnessFailure, parseVersion, scratchFolder } from "@cerium/harness";
import type { AuthStatus, HarnessStatus } from "@cerium/protocol";
import { Duration, Effect, FileSystem, Option, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { RUN_ENV } from "./launch.ts";
import { INSTALL_HINT, LOGIN_COMMAND } from "./manifest.ts";

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "antigravity", message, cause });

/** What one short `agy` command printed and how it ended. */
export interface AgyOutput {
  readonly code: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a short `agy` command outside any project, with stdin closed: a signed-out `-p` would otherwise
 * wait a minute for a pasted code. Times out after `timeout`.
 */
export const runAgy = (
  executable: string,
  args: ReadonlyArray<string>,
  timeout: Duration.Input = "30 seconds",
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cwd = yield* scratchFolder("antigravity", "probe");
    const handle = yield* spawner.spawn(
      ChildProcess.make(executable, [...args], {
        cwd,
        extendEnv: true,
        env: { ...RUN_ENV },
        stdin: "ignore",
      }),
    );
    const text = (stream: Stream.Stream<Uint8Array, unknown>) =>
      stream.pipe(
        Stream.decodeText(),
        Stream.mkString,
        Effect.orElseSucceed(() => ""),
      );
    const [stdout, stderr, code] = yield* Effect.all(
      [
        text(handle.stdout),
        text(handle.stderr),
        handle.exitCode.pipe(
          Effect.map((exit): number | undefined => Number(exit)),
          Effect.orElseSucceed(() => undefined),
        ),
      ],
      { concurrency: "unbounded" },
    );
    return { code, stdout, stderr } satisfies AgyOutput;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(failure(`\`agy ${args.join(" ")}\` did not finish in time`)(args)),
    }),
    Effect.mapError((cause) =>
      cause instanceof HarnessFailure ? cause : failure(`Could not run \`agy ${args.join(" ")}\``)(cause),
    ),
  );

/**
 * The user's `agy`: the first on PATH, else where Google's installer puts it (`~/.local/bin`, or
 * `%LOCALAPPDATA%\agy\bin` on Windows), which a GUI app's PATH may leave out.
 */
export const findAntigravityExecutable = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const windows = process.platform === "win32";
  const onPath = yield* findOnPath(windows ? "agy.exe" : "agy");
  const local = process.env["LOCALAPPDATA"];
  const candidates = [
    ...onPath,
    windows
      ? local === undefined
        ? undefined
        : path.join(local, "agy", "bin", "agy.exe")
      : path.join(homedir(), ".local", "bin", "agy"),
  ].filter((candidate): candidate is string => candidate !== undefined);
  for (const candidate of candidates) {
    if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) return Option.some(candidate);
  }
  return Option.none<string>();
});

/** `agy models` says this when nobody is signed in (seen live, 1.4.12). */
export const SIGNED_OUT = /please sign in|not logged in|authentication required|sign in to/i;

/**
 * How the user signs Antigravity in, as Settings names it: a Gemini API key, Google Cloud (ADC), or a
 * personal Google account, which Google's terms don't cover for third-party apps.
 */
export const signInMethod = (
  env: NodeJS.ProcessEnv,
  settings: unknown,
): "apiKey" | "googleCloud" | "google" => {
  const provider =
    typeof settings === "object" && settings !== null
      ? (settings as Record<string, unknown>)["modelProvider"]
      : undefined;
  if (provider === "gemini" && (env["GEMINI_API_KEY"] ?? "") !== "") return "apiKey";
  if (/^(1|true|yes)$/i.test(env["AGY_ADC_AUTH"] ?? "")) return "googleCloud";
  return "google";
};

/** The user's `settings.json`, or nothing when it can't be read. */
export const readSettings = (geminiHome: string) =>
  Effect.promise(() =>
    readFile(join(geminiHome, "antigravity-cli", "settings.json"), "utf8").then(
      (text): unknown => {
        try {
          return JSON.parse(text);
        } catch {
          return undefined;
        }
      },
      () => undefined,
    ),
  );

/**
 * Finds Antigravity CLI and reads its sign-in from `agy models`, which answers at once either way:
 * the list when signed in, "Please sign in" when not. Nothing is spent.
 */
export const probeAntigravity = (geminiHome: string) =>
  Effect.gen(function* () {
    const executable = yield* findAntigravityExecutable;
    if (Option.isNone(executable)) {
      return {
        _tag: "HarnessMissing",
        provider: "antigravity",
        installHint: INSTALL_HINT,
      } satisfies HarnessStatus;
    }
    const printed = yield* runAgy(executable.value, ["--version"], "15 seconds");
    const version = parseVersion(printed.stdout) ?? parseVersion(printed.stderr);
    if (version === undefined) return yield* failure("Could not read the Antigravity CLI version")(printed);
    const models = yield* runAgy(executable.value, ["models"], "45 seconds");
    const signedOut = models.code !== 0 && SIGNED_OUT.test(`${models.stderr}\n${models.stdout}`);
    const method = signInMethod(process.env, yield* readSettings(geminiHome));
    const auth: AuthStatus = signedOut
      ? { _tag: "LoggedOut", loginCommand: LOGIN_COMMAND }
      : { _tag: "LoggedIn", method: method === "google" ? "google" : method };
    return {
      _tag: "HarnessInstalled",
      provider: "antigravity",
      executablePath: executable.value,
      version,
      auth,
    } satisfies HarnessStatus;
  });
