import { HarnessFailure, HarnessUnavailable } from "@cerium/harness";
import { Effect, type Duration } from "effect";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  CancellationTokenSource,
  createMessageConnection,
  ErrorCodes,
  ResponseError,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

export const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "copilot", message, cause });

export const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const stop = (process: ChildProcessWithoutNullStreams, exited: Promise<void>) =>
  Effect.gen(function* () {
    yield* Effect.sync(() => process.stdin.end());
    const wait = Effect.promise(() => exited);
    yield* wait.pipe(
      Effect.timeoutOrElse({
        duration: "1 second",
        orElse: () =>
          Effect.sync(() => process.kill()).pipe(
            Effect.andThen(wait),
            Effect.timeoutOrElse({
              duration: "1 second",
              orElse: () => Effect.sync(() => process.kill("SIGKILL")),
            }),
          ),
      }),
    );
  });

/** One private JSON-RPC connection to the user's CLI. GitHub's SDK v2 defines protocol 4. */
export const openCopilot = Effect.fn("CopilotAdapter.openCopilot")(function* (
  executablePath: string,
  cwd: string,
) {
  const { connection, exited } = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const env = { ...process.env };
        // Startup flags inherited from a terminal must not override the thread's access mode.
        delete env["COPILOT_ALLOW_ALL"];
        delete env["COPILOT_ASSISTED_APPROVAL"];
        const child = spawn(
          executablePath,
          [
            "--headless",
            "--stdio",
            "--no-auto-update",
            "--disable-client-telemetry",
            "--sync-session=off",
            "--disable-builtin-mcps",
            "--secret-env-vars=COPILOT_GITHUB_TOKEN,GH_TOKEN,GITHUB_TOKEN",
          ],
          { cwd, env, stdio: "pipe", windowsHide: true },
        );
        const connection = createMessageConnection(
          new StreamMessageReader(child.stdout),
          new StreamMessageWriter(child.stdin),
        );
        // Keep stderr drained. Arbitrary CLI output can contain paths, config or authentication data.
        child.stderr.resume();
        const exited = new Promise<void>((resolve) => {
          child.once("error", () => {
            connection.dispose();
            resolve();
          });
          child.once("close", () => {
            connection.dispose();
            resolve();
          });
        });
        connection.listen();
        return { child, connection, exited };
      },
      catch: failure("Could not launch GitHub Copilot CLI"),
    }),
    ({ child, connection, exited }) =>
      stop(child, exited).pipe(Effect.ensuring(Effect.sync(() => connection.dispose()))),
  );

  const request = (
    method: string,
    params: Record<string, unknown> = {},
    timeout: Duration.Input = "30 seconds",
  ) =>
    Effect.tryPromise({
      try: async (signal) => {
        const token = new CancellationTokenSource();
        const cancel = () => token.cancel();
        signal.addEventListener("abort", cancel, { once: true });
        try {
          return await connection.sendRequest<unknown>(method, params, token.token);
        } finally {
          signal.removeEventListener("abort", cancel);
          token.dispose();
        }
      },
      catch: failure(`GitHub Copilot CLI could not handle ${method}`),
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(failure(`GitHub Copilot CLI timed out handling ${method}`)(undefined)),
      }),
    );

  const response = yield* request("connect", {
    clientInfo: { editorName: "Cerium" },
    supportedTaskKinds: ["agent", "shell"],
  }).pipe(
    Effect.catchIf(
      (error) => error.cause instanceof ResponseError && error.cause.code === ErrorCodes.MethodNotFound,
      () => request("ping"),
    ),
  );
  const version = record(response)?.["protocolVersion"];
  if (version !== 4) {
    return yield* new HarnessUnavailable({
      provider: "copilot",
      reason: "versionTooOld",
      message: `Cerium requires GitHub Copilot CLI protocol 4 (reported ${typeof version === "number" ? version : "unknown"}). Run \`copilot update\`.`,
    });
  }

  return { connection, request, exited };
});

export type CopilotHost = Effect.Success<ReturnType<typeof openCopilot>>;
