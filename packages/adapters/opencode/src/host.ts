import { HarnessFailure } from "@cerium/harness";
import { OpenCode } from "@opencode/client";
import { Deferred, Duration, Effect, Option, Queue, Schema, Stream, type Cause } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { randomBytes } from "node:crypto";

// One private `opencode serve --stdio` and a client for it. The server binds a free loopback port,
// prints `{"url": …}` once it serves, and treats the end of its stdin as the end of its lease, so it
// stops even when Cerium dies without closing it. Sessions, the probe and the model listing each own a
// host for as long as they need it; closing the scope ends the process.

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "opencode", message, cause });

/** How long a cold `opencode serve` may take to print its URL. */
const STARTUP = Duration.seconds(60);
/** How long the server may drain (finish writing, stop its MCP servers) after its lease ends. */
const SHUTDOWN_GRACE = Duration.seconds(5);
const STDERR_LINES = 20;

const Ready = Schema.Struct({ url: Schema.String });
const decodeReady = Schema.decodeUnknownOption(Schema.fromJsonString(Ready));

/** The client, as an interface: its inferred type names modules the package doesn't export. */
export interface OpenCodeClient extends ReturnType<typeof OpenCode.make> {}

export interface OpenCodeHost {
  readonly client: OpenCodeClient;
  /** Resolves once the server has exited. */
  readonly exited: Effect.Effect<void>;
  /** The server's last words on stderr, which explain an unexpected exit. */
  readonly stderr: () => string | undefined;
}

export interface HostOptions {
  /** The folder the server starts in; its default Location. */
  readonly cwd?: string;
  /** Configuration merged over the user's own (`OPENCODE_CONFIG_CONTENT`). */
  readonly config?: Record<string, unknown>;
}

/**
 * Configuration the user already passes in `OPENCODE_CONFIG_CONTENT` stays, with Cerium's keys over it;
 * MCP servers merge so the user's inline ones stay beside Cerium's.
 */
export const configContent = (
  config: Record<string, unknown>,
  inherited: string | undefined = process.env["OPENCODE_CONFIG_CONTENT"],
): string => {
  const parsed: unknown = inherited === undefined ? undefined : Option.getOrUndefined(parseJson(inherited));
  const base = isRecord(parsed) ? parsed : {};
  const servers = (value: unknown) => (isRecord(value) && isRecord(value["servers"]) ? value["servers"] : {});
  const mcp =
    "mcp" in config || "mcp" in base
      ? {
          mcp: {
            ...(isRecord(base["mcp"]) ? base["mcp"] : {}),
            ...(isRecord(config["mcp"]) ? config["mcp"] : {}),
            servers: { ...servers(base["mcp"]), ...servers(config["mcp"]) },
          },
        }
      : {};
  return JSON.stringify({ ...base, ...config, ...mcp });
};

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Starts `opencode serve --stdio` and waits until it serves. The server lives until the scope closes. */
export const openHost = Effect.fn("OpenCodeAdapter.openHost")(function* (
  executablePath: string,
  options: HostOptions = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const password = randomBytes(32).toString("base64url");
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(executablePath, ["serve", "--stdio", "--port", "0"], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        extendEnv: true,
        env: {
          // The server keeps the lease password out of the environment its tools inherit.
          OPENCODE_PASSWORD: password,
          ...(options.config === undefined ? {} : { OPENCODE_CONFIG_CONTENT: configContent(options.config) }),
        },
      }),
    )
    .pipe(Effect.mapError(failure("Could not start `opencode serve`")));

  const lease = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const url = yield* Deferred.make<string, HarnessFailure>();
  const exited = yield* Deferred.make<void>();
  const stderr: Array<string> = [];
  const lastWords = () => stderr.filter((line) => line.trim() !== "").at(-1);

  // Nothing is ever written: the pipe stays open until the lease ends.
  yield* Stream.fromQueue(lease).pipe(Stream.run(handle.stdin), Effect.ignore, Effect.forkScoped);
  yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      Option.match(decodeReady(line), {
        onNone: () => Effect.void,
        onSome: (ready) => Deferred.succeed(url, ready.url),
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );
  yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      Effect.sync(() => {
        stderr.push(line);
        if (stderr.length > STDERR_LINES) stderr.shift();
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );
  yield* handle.exitCode.pipe(
    Effect.ignore,
    Effect.andThen(
      Deferred.fail(
        url,
        failure(`\`opencode serve\` exited before serving${lastWords() ? `: ${lastWords()}` : ""}`)(
          stderr.join("\n"),
        ),
      ),
    ),
    Effect.andThen(Deferred.succeed(exited, undefined)),
    Effect.forkScoped,
  );
  // Ending the lease lets the server stop on its own; the spawn's own finalizer kills one that hangs.
  yield* Effect.addFinalizer(() =>
    Queue.end(lease).pipe(
      Effect.andThen(Deferred.await(exited)),
      Effect.timeout(SHUTDOWN_GRACE),
      Effect.ignore,
    ),
  );

  const baseUrl = yield* Deferred.await(url).pipe(
    Effect.timeoutOrElse({
      duration: STARTUP,
      orElse: () => Effect.fail(failure("`opencode serve` did not start in time")(stderr.join("\n"))),
    }),
  );
  const host: OpenCodeHost = {
    client: OpenCode.make({
      baseUrl,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
    }),
    exited: Deferred.await(exited),
    stderr: lastWords,
  };
  return host;
});

/** One client call as an effect; `what` names it in the failure. */
export const call = <A>(what: string, run: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      failure(
        `OpenCode couldn't ${what}${cause instanceof Error && cause.message ? `: ${cause.message}` : ""}`,
      )(cause),
  });
