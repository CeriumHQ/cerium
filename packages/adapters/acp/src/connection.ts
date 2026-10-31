import { HarnessFailure } from "@cerium/harness";
import type { ProviderId } from "@cerium/protocol";
import { Cause, Data, Deferred, Duration, Effect, Queue, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  PROTOCOL_VERSION,
  type ClientCapabilities,
  type InitializeRequest,
  type InitializeResponse,
} from "./schema.ts";

// One ACP agent process and a JSON-RPC 2.0 connection to it over newline-delimited JSON on its stdio,
// as ACP's stdio transport defines it. The agent can call back (permission requests, and any method a
// client capability promised); a handler answers each. Closing the scope ends the process: stdin
// closes first, which ACP agents take as the end of the connection, and the spawn's own finalizer
// kills one that hangs on.

/** The agent answered a request with an error, or the connection ended before it answered. */
export class AcpError extends Data.TaggedError("AcpError")<{
  readonly method: string;
  /** The JSON-RPC error code; absent when the connection itself failed. */
  readonly code?: number;
  readonly message: string;
  readonly data?: unknown;
}> {}

/** A handler's way to answer a request with a JSON-RPC error. */
export class AcpRequestError extends Data.TaggedError("AcpRequestError")<{
  readonly code: number;
  readonly message: string;
}> {}

export type IncomingRequestHandler = (
  method: string,
  params: unknown,
) => Effect.Effect<unknown, AcpRequestError>;

/** A frame as it crossed the wire, for fixture recording. */
export interface WireFrame {
  readonly direction: "in" | "out";
  readonly message: unknown;
}

export interface AcpConnection {
  readonly initialized: InitializeResponse;
  request<A = unknown>(method: string, params: unknown): Effect.Effect<A, AcpError>;
  notify(method: string, params: unknown): Effect.Effect<void>;
  /** Replaces the listener for the agent's notifications. */
  onNotification(listener: (method: string, params: unknown) => void): void;
  /** Replaces the handler for the agent's requests; without one, they are refused as unknown. */
  onRequest(handler: IncomingRequestHandler): void;
  /** Resolves with the exit code once the process has exited. */
  readonly exited: Effect.Effect<number | undefined>;
  /** Whether the process has exited. */
  readonly hasExited: () => boolean;
  /** The process's last words on stderr, which explain a refusal or an exit. */
  readonly stderr: () => string | undefined;
}

export interface SpawnOptions {
  readonly provider: ProviderId;
  /** What the harness is called in failures: "Grok Build". */
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  /** Added to the inherited environment. */
  readonly env?: Readonly<Record<string, string>>;
  readonly clientCapabilities?: ClientCapabilities;
  /** The agent's own extras on `initialize` (Grok reads appended instructions there). */
  readonly initializeMeta?: Readonly<Record<string, unknown>>;
  /** How long the agent may take to answer `initialize` (default 60 s: a cold start can update itself). */
  readonly initializeTimeout?: Duration.Input;
  /** Sees every frame, in order (the fixture recorder). */
  readonly record?: (frame: WireFrame) => void;
}

const CLIENT_INFO = { name: "cerium", title: "Cerium", version: "0.0.0" };

/**
 * What Cerium offers every agent: no file system or terminal of its own (agents use their own tools,
 * which ask through `session/request_permission`), and the session updates it shows.
 */
export const DEFAULT_CLIENT_CAPABILITIES: ClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  session: { compaction: {}, configOptions: { boolean: {} }, notices: {} },
};

const STDERR_LINES = 40;
const SHUTDOWN_GRACE = Duration.seconds(5);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type Pending = Deferred.Deferred<unknown, AcpError>;

/**
 * Spawns the agent and completes `initialize`. Requests and notifications flow until the scope closes
 * or the process exits; requests still waiting then fail with an `AcpError`.
 */
export const openAcpConnection = Effect.fn("AcpConnection.open")(function* (options: SpawnOptions) {
  const failure = (message: string) => (cause: unknown) =>
    new HarnessFailure({ provider: options.provider, message, cause });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(options.command, [...options.args], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        extendEnv: true,
        ...(options.env === undefined ? {} : { env: { ...options.env } }),
      }),
    )
    .pipe(Effect.mapError(failure(`Could not start ${options.name}`)));

  const outbox = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const encoder = new TextEncoder();
  const exited = yield* Deferred.make<number | undefined>();
  const stderr: Array<string> = [];
  const lastWords = () => stderr.filter((line) => line.trim() !== "").at(-1);
  const pending = new Map<number | string, { readonly method: string; readonly answer: Pending }>();
  let nextId = 0;
  let listener: (method: string, params: unknown) => void = () => undefined;
  let handler: IncomingRequestHandler | undefined;
  let ended = false;

  const write = (message: Record<string, unknown>) => {
    if (ended) return;
    const framed = { jsonrpc: "2.0", ...message };
    options.record?.({ direction: "out", message: framed });
    Queue.offerUnsafe(outbox, encoder.encode(`${JSON.stringify(framed)}\n`));
  };

  const respond = (id: unknown, outcome: { result: unknown } | { error: AcpRequestError }) =>
    write(
      "result" in outcome
        ? { id, result: outcome.result ?? null }
        : { id, error: { code: outcome.error.code, message: outcome.error.message } },
    );

  const receive = (line: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (line.trim() === "") return Effect.void;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        // Agents log to stdout by mistake now and then; a line that isn't JSON-RPC is not a frame.
        return Effect.logDebug(`${options.name} wrote a line that isn't JSON`, line.slice(0, 200));
      }
      if (!isRecord(message)) return Effect.void;
      options.record?.({ direction: "in", message });
      const id = message["id"];
      const method = typeof message["method"] === "string" ? message["method"] : undefined;
      if (method === undefined) {
        // A response to one of Cerium's requests.
        if (typeof id !== "number" && typeof id !== "string") return Effect.void;
        const waiting = pending.get(id);
        if (waiting === undefined) return Effect.void;
        pending.delete(id);
        const error = message["error"];
        return isRecord(error)
          ? Deferred.fail(
              waiting.answer,
              new AcpError({
                method: waiting.method,
                ...(typeof error["code"] === "number" ? { code: error["code"] } : {}),
                message: typeof error["message"] === "string" ? error["message"] : "Unknown error",
                data: error["data"],
              }),
            ).pipe(Effect.asVoid)
          : Deferred.succeed(waiting.answer, message["result"]).pipe(Effect.asVoid);
      }
      if (id === undefined || id === null) {
        // A notification. A listener that throws must not stop the pump.
        try {
          listener(method, message["params"]);
        } catch (cause) {
          return Effect.logWarning(`Handling ${options.name}'s \`${method}\` failed`, cause);
        }
        return Effect.void;
      }
      // A request from the agent, which may wait on the user (a permission), so it runs on its own.
      const answer =
        handler === undefined
          ? Effect.fail(new AcpRequestError({ code: -32601, message: `Method not found: ${method}` }))
          : handler(method, message["params"]);
      return answer.pipe(
        Effect.match({
          onSuccess: (result) => respond(id, { result }),
          onFailure: (error) => respond(id, { error }),
        }),
        Effect.forkIn(scope),
        Effect.asVoid,
      );
    });

  const end = Effect.gen(function* () {
    ended = true;
    for (const [, waiting] of pending) {
      yield* Deferred.fail(
        waiting.answer,
        new AcpError({
          method: waiting.method,
          message: `${options.name} exited${lastWords() ? `: ${lastWords()}` : ""}`,
        }),
      );
    }
    pending.clear();
  });

  yield* Stream.fromQueue(outbox).pipe(Stream.run(handle.stdin), Effect.ignore, Effect.forkScoped);
  yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach(receive),
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
    Effect.map((code): number | undefined => Number(code)),
    Effect.orElseSucceed(() => undefined),
    Effect.tap(() => end),
    Effect.flatMap((code) => Deferred.succeed(exited, code)),
    Effect.forkScoped,
  );
  // Closing stdin ends the connection; an agent that doesn't stop is killed by the spawn's finalizer.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* end;
      yield* Queue.end(outbox);
      yield* Deferred.await(exited).pipe(Effect.timeout(SHUTDOWN_GRACE), Effect.ignore);
    }),
  );

  const request = <A = unknown>(method: string, params: unknown): Effect.Effect<A, AcpError> =>
    Effect.suspend(() => {
      if (ended) {
        return Effect.fail(
          new AcpError({
            method,
            message: `${options.name} is not running${lastWords() ? `: ${lastWords()}` : ""}`,
          }),
        );
      }
      const id = nextId++;
      const answer = Deferred.makeUnsafe<unknown, AcpError>();
      pending.set(id, { method, answer });
      write({ id, method, params });
      return Deferred.await(answer).pipe(
        // An interrupted wait (an interrupt, a timeout) asks the agent to drop the request too.
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            if (!pending.delete(id)) return;
            write({ method: "$/cancel_request", params: { requestId: id } });
          }),
        ),
      ) as Effect.Effect<A, AcpError>;
    });

  const connection: AcpConnection = {
    initialized: undefined as unknown as InitializeResponse,
    request,
    notify: (method, params) => Effect.sync(() => write({ method, params })),
    onNotification: (next) => void (listener = next),
    onRequest: (next) => void (handler = next),
    exited: Deferred.await(exited),
    hasExited: () => Deferred.isDoneUnsafe(exited),
    stderr: lastWords,
  };

  const initialize: InitializeRequest = {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: options.clientCapabilities ?? DEFAULT_CLIENT_CAPABILITIES,
    clientInfo: CLIENT_INFO,
    ...(options.initializeMeta === undefined ? {} : { _meta: { ...options.initializeMeta } }),
  };
  const initialized = yield* request<InitializeResponse>("initialize", initialize).pipe(
    Effect.timeoutOrElse({
      duration: options.initializeTimeout ?? Duration.seconds(60),
      orElse: () =>
        Effect.fail(
          new AcpError({ method: "initialize", message: `${options.name} did not answer in time` }),
        ),
    }),
    Effect.mapError((error) =>
      failure(`${options.name} did not start${lastWords() ? `: ${lastWords()}` : `: ${error.message}`}`)(
        error,
      ),
    ),
  );
  if (!isRecord(initialized) || typeof initialized.protocolVersion !== "number") {
    return yield* failure(`${options.name} answered \`initialize\` with something that isn't ACP`)(
      initialized,
    );
  }
  if (initialized.protocolVersion !== PROTOCOL_VERSION) {
    return yield* failure(
      `${options.name} speaks ACP version ${initialized.protocolVersion}; Cerium speaks version ${PROTOCOL_VERSION}`,
    )(initialized);
  }
  return { ...connection, initialized } satisfies AcpConnection;
});

/** Whether an ACP error says the agent needs a sign-in. */
export const isAuthError = (error: AcpError) =>
  error.code === -32000 || /auth|log ?in|sign ?in|credential|api key/i.test(error.message);

/** For callers that keep a connection longer than one scope (the adapter's shared probe). */
export type AcpScope = Scope.Scope;
