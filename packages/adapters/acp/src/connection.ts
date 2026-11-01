import { HarnessFailure } from "@cerium/harness";
import type { ProviderId } from "@cerium/protocol";
import {
  Deferred,
  Duration,
  Effect,
  Option,
  Queue,
  Schema,
  Semaphore,
  Stream,
  type Cause,
  type Scope,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { Initialized } from "./schema.ts";

// A JSON-RPC 2.0 connection to one Agent Client Protocol agent over stdio, one JSON message per line
// each way. What the agent sends about a session goes to whatever attached to that session, so one
// process can serve several (probes, listings and quick completions share one); what arrives for a
// session before anything attached to it waits for it, as the updates right after `session/new`'s
// answer do.

/** The agent answered a request with an error. */
export class AcpRequestError extends Schema.TaggedError<AcpRequestError>()("AcpRequestError", {
  method: Schema.String,
  code: Schema.Finite,
  message: Schema.String,
  data: Schema.optionalKey(Schema.Unknown),
}) {}

/** JSON-RPC's code for a method the receiver doesn't serve. */
export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;
/** ACP's code for a request the agent can't serve until the user signs in. */
export const AUTH_REQUIRED = -32000;

export type RequestId = string | number;
export type Params = Readonly<Record<string, unknown>>;

/** Where the agent's messages about one session go. */
export interface SessionListener {
  readonly notification: (method: string, params: Params) => Effect.Effect<void>;
  /** Answers a request the agent makes in the session, such as `session/request_permission`. */
  readonly request: (method: string, params: Params) => Effect.Effect<unknown, AcpRequestError>;
}

/** How to start the agent. */
export interface AcpCommand {
  readonly provider: ProviderId;
  /** The harness as the user knows it, for messages: "Grok", "Antigravity". */
  readonly label: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  /** Set beside the environment the process inherits. */
  readonly env?: Readonly<Record<string, string>>;
  /** Runs it through the shell, as Windows' `.cmd` shims need. */
  readonly shell?: boolean;
  /** What the client calls itself in `initialize`. */
  readonly clientVersion?: string;
  /** Vendor notices outside JSON-RPC (for example the harness's own browser sign-in URL). */
  readonly onLine?: (line: string) => Effect.Effect<void>;
}

export interface AcpConnection {
  /** What the agent answered `initialize` with. */
  readonly initialized: Initialized;
  request(method: string, params: unknown): Effect.Effect<unknown, AcpRequestError | HarnessFailure>;
  notify(method: string, params: unknown): Effect.Effect<void>;
  /**
   * Sends what the agent says about `sessionId` to `listener` until the scope closes, starting with
   * what it said before. Once detached, the agent's requests about the session are refused.
   */
  attach(sessionId: string, listener: SessionListener): Effect.Effect<void, never, Scope.Scope>;
  /** Hears the notifications that name no session, until the scope closes. */
  listen(
    listener: (method: string, params: Params) => Effect.Effect<void>,
  ): Effect.Effect<void, never, Scope.Scope>;
  /** Resolves once the process has exited. */
  readonly exited: Effect.Effect<void>;
  /** The end of what the process wrote to stderr, which explains an unexpected exit. */
  readonly stderr: () => string;
}

type Incoming =
  | { readonly kind: "notification"; readonly method: string; readonly params: Params }
  | { readonly kind: "request"; readonly id: RequestId; readonly method: string; readonly params: Params };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeInitialized = Schema.decodeUnknownEffect(Initialized);

const STDERR_LINES = 30;
const SHUTDOWN_GRACE = Duration.seconds(3);
const INITIALIZE_TIMEOUT = Duration.seconds(60);
/** What waits for a session nothing attached to yet, per session and in all. */
const EARLY_PER_SESSION = 5_000;
const EARLY_SESSIONS = 32;

/**
 * Starts the agent and completes ACP's `initialize`. The process lives until the enclosing scope
 * closes: its stdin closes first, which ACP agents exit on, and one that doesn't in time is killed.
 */
export const connect = Effect.fn("Acp.connect")(function* (command: AcpCommand) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const failure = (message: string) => (cause: unknown) =>
    new HarnessFailure({ provider: command.provider, message, cause });

  const handle = yield* spawner
    .spawn(
      ChildProcess.make(command.executable, [...command.args], {
        ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
        ...(command.env === undefined ? {} : { env: { ...command.env }, extendEnv: true }),
        ...(command.shell === true ? { shell: true } : {}),
      }),
    )
    .pipe(Effect.mapError(failure(`Could not start ${command.label}`)));

  const outgoing = yield* Queue.unbounded<string, Cause.Done>();
  const exited = yield* Deferred.make<void>();
  const pending = new Map<
    number,
    {
      readonly method: string;
      readonly response: Deferred.Deferred<unknown, AcpRequestError | HarnessFailure>;
    }
  >();
  const listeners = new Map<string, SessionListener>();
  const detached = new Set<string>();
  const early = new Map<string, Array<Incoming>>();
  const globals = new Set<(method: string, params: Params) => Effect.Effect<void>>();
  // Routing and attaching take turns, so what waited for a session reaches it before anything newer.
  const routing = yield* Semaphore.make(1);
  const stderr: Array<string> = [];
  let nextId = 1;

  const send = (message: object) =>
    Queue.offer(outgoing, JSON.stringify({ jsonrpc: "2.0", ...message })).pipe(Effect.asVoid);
  const respondError = (id: RequestId, code: number, message: string) =>
    send({ id, error: { code, message } });

  const deliver = (listener: SessionListener, message: Incoming): Effect.Effect<void> =>
    message.kind === "notification"
      ? listener.notification(message.method, message.params)
      : // A request can wait on the user (a permission), so it never holds up the messages after it.
        listener.request(message.method, message.params).pipe(
          Effect.matchEffect({
            onSuccess: (result) => send({ id: message.id, result: result ?? null }),
            onFailure: (error) => respondError(message.id, error.code, error.message),
          }),
          Effect.forkIn(scope),
          Effect.asVoid,
        );

  const keep = (sessionId: string, message: Incoming) => {
    const waiting = early.get(sessionId) ?? [];
    if (waiting.length === 0) {
      if (early.size >= EARLY_SESSIONS) early.delete(early.keys().next().value ?? "");
      early.set(sessionId, waiting);
    }
    if (waiting.length < EARLY_PER_SESSION) waiting.push(message);
  };

  const route = (message: Incoming): Effect.Effect<void> => {
    const sessionId =
      typeof message.params["sessionId"] === "string" ? message.params["sessionId"] : undefined;
    if (sessionId === undefined) {
      if (message.kind === "request") {
        return respondError(message.id, METHOD_NOT_FOUND, `Cerium does not serve ${message.method}`);
      }
      return Effect.forEach([...globals], (listener) => listener(message.method, message.params), {
        discard: true,
      });
    }
    const listener = listeners.get(sessionId);
    if (listener !== undefined) return deliver(listener, message);
    if (detached.has(sessionId)) {
      return message.kind === "request"
        ? respondError(message.id, INTERNAL_ERROR, "The session has closed")
        : Effect.void;
    }
    return Effect.sync(() => keep(sessionId, message));
  };

  const dispatch = (line: string): Effect.Effect<void> => {
    const message = Option.getOrUndefined(parseLine(line));
    if (!isRecord(message)) return command.onLine?.(line) ?? Effect.void;
    const { id, method } = message;
    if (typeof method === "string") {
      const params: Params = isRecord(message["params"]) ? message["params"] : {};
      const incoming: Incoming =
        typeof id === "string" || typeof id === "number"
          ? { kind: "request", id, method, params }
          : { kind: "notification", method, params };
      return routing.withPermits(1)(route(incoming));
    }
    // A response: the adapter's own requests have numeric ids.
    if (typeof id !== "number") return Effect.void;
    const waiting = pending.get(id);
    pending.delete(id);
    if (waiting === undefined) return Effect.void;
    const error = message["error"];
    if (isRecord(error)) {
      return Deferred.fail(
        waiting.response,
        new AcpRequestError({
          method: waiting.method,
          code: typeof error["code"] === "number" ? error["code"] : INTERNAL_ERROR,
          message: typeof error["message"] === "string" ? error["message"] : "The agent refused the request",
          ...(error["data"] === undefined ? {} : { data: error["data"] }),
        }),
      ).pipe(Effect.asVoid);
    }
    return Deferred.succeed(waiting.response, message["result"]).pipe(Effect.asVoid);
  };

  const gone = () =>
    new HarnessFailure({
      provider: command.provider,
      message: `${command.label} exited`,
      cause: stderr.join("\n"),
    });

  const closed = Effect.gen(function* () {
    for (const waiting of pending.values()) yield* Deferred.fail(waiting.response, gone());
    pending.clear();
    yield* Deferred.succeed(exited, undefined);
  });

  yield* Stream.fromQueue(outgoing).pipe(
    Stream.map((line) => `${line}\n`),
    Stream.encodeText,
    Stream.run(handle.stdin),
    Effect.ignore,
    Effect.forkScoped,
  );
  yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach(dispatch),
    Effect.ignore,
    Effect.ensuring(closed),
    Effect.forkScoped,
  );
  // Drained so the pipe never fills.
  yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      Effect.sync(() => {
        stderr.push(line);
        if (stderr.length > STDERR_LINES) stderr.shift();
      }).pipe(Effect.andThen(command.onLine?.(line) ?? Effect.void)),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );
  // Registered after the fibers above, so it runs while the stdin writer is still alive.
  yield* Effect.addFinalizer(() =>
    Queue.end(outgoing).pipe(
      Effect.andThen(Deferred.await(exited)),
      Effect.timeout(SHUTDOWN_GRACE),
      Effect.ignore,
    ),
  );

  const request = (method: string, params: unknown) =>
    Effect.gen(function* () {
      const id = nextId++;
      const response = yield* Deferred.make<unknown, AcpRequestError | HarnessFailure>();
      pending.set(id, { method, response });
      return yield* send({ id, method, params }).pipe(
        Effect.andThen(Deferred.await(response)),
        Effect.raceFirst(Deferred.await(exited).pipe(Effect.andThen(Effect.fail(gone())))),
        Effect.ensuring(Effect.sync(() => pending.delete(id))),
      );
    });

  const answer = yield* request("initialize", {
    protocolVersion: 1,
    // Cerium serves no files or terminals: agents use their own tools, which ask through permissions.
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "cerium", title: "Cerium", version: command.clientVersion ?? "0.0.0" },
  }).pipe(
    Effect.timeoutOrElse({
      duration: INITIALIZE_TIMEOUT,
      orElse: () => Effect.fail(failure(`${command.label} did not answer initialize`)(stderr.join("\n"))),
    }),
    Effect.mapError((cause) =>
      cause._tag === "HarnessFailure" ? cause : failure(`${command.label} refused to initialize`)(cause),
    ),
  );
  const initialized = yield* decodeInitialized(answer).pipe(
    Effect.mapError(failure(`${command.label} answered initialize unexpectedly`)),
  );

  const connection: AcpConnection = {
    initialized,
    request,
    notify: (method, params) => send({ method, params }),
    attach: (sessionId, listener) =>
      Effect.acquireRelease(
        routing.withPermits(1)(
          Effect.gen(function* () {
            listeners.set(sessionId, listener);
            detached.delete(sessionId);
            const waiting = early.get(sessionId) ?? [];
            early.delete(sessionId);
            for (const message of waiting) yield* deliver(listener, message);
          }),
        ),
        () =>
          Effect.sync(() => {
            listeners.delete(sessionId);
            detached.add(sessionId);
          }),
      ),
    listen: (listener) =>
      Effect.acquireRelease(
        Effect.sync(() => globals.add(listener)),
        () => Effect.sync(() => globals.delete(listener)),
      ).pipe(Effect.asVoid),
    exited: Deferred.await(exited),
    stderr: () => stderr.join("\n"),
  };
  return connection;
});
