import type { HarnessFailure } from "@cerium/harness";
import { Cause, Deferred, Effect, Queue, Stream, type Duration } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { AcpError, ErrorCode } from "./errors.ts";
import { harnessFailure, type AcpHarness } from "./harness.ts";
import { record, string, type JsonRecord } from "./json.ts";

export type RequestId = string | number;

/** A request or notification the agent sent the client. Requests carry an `id` to answer. */
export interface Incoming {
  readonly method: string;
  readonly params: unknown;
  readonly id?: RequestId;
}

/** How to run the agent: its executable, arguments and folder, and any environment it adds. */
export interface AcpCommand {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  /** Added to the inherited environment. */
  readonly env?: Readonly<Record<string, string>>;
}

/** Fields `initialize` adds for a harness that reads extensions there. */
export interface InitializeOptions {
  readonly meta?: JsonRecord;
}

/** What the agent said about itself in `initialize`. */
export interface AgentInfo {
  /** The whole `initialize` result. */
  readonly raw: JsonRecord;
  readonly capabilities: JsonRecord | undefined;
  readonly authMethods: ReadonlyArray<unknown>;
  readonly meta: JsonRecord | undefined;
  /** `session/load`, which replays the session's history as updates. */
  readonly loadSession: boolean;
  /** `session/resume`, which continues a session without replaying it. */
  readonly resumeSession: boolean;
  readonly images: boolean;
  readonly httpMcp: boolean;
}

const QUERY_TIMEOUT: Duration.Input = "30 seconds";
/** How long the agent gets to finish writing its state once its input ends, before it is killed. */
const SHUTDOWN_GRACE: Duration.Input = "3 seconds";

const parse = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

const agentInfo = (raw: JsonRecord): AgentInfo => {
  const capabilities = record(raw["agentCapabilities"]);
  return {
    raw,
    capabilities,
    authMethods: Array.isArray(raw["authMethods"]) ? raw["authMethods"] : [],
    meta: record(raw["_meta"]),
    loadSession: capabilities?.["loadSession"] === true,
    resumeSession: record(capabilities?.["sessionCapabilities"])?.["resume"] !== undefined,
    images: record(capabilities?.["promptCapabilities"])?.["image"] === true,
    httpMcp: record(capabilities?.["mcpCapabilities"])?.["http"] === true,
  };
};

/**
 * One ACP v1 JSON-RPC connection over a subprocess's stdin and stdout, after `initialize` has
 * negotiated version 1. Closing the scope ends the agent's input and gives it a moment to exit.
 *
 * Lines that aren't JSON-RPC 2.0 are skipped, so a stray log line can't end the connection.
 */
export const connect = Effect.fn("Acp.connect")(function* (
  harness: AcpHarness,
  command: AcpCommand,
  initialize: InitializeOptions = {},
) {
  const failure = harnessFailure(harness);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // The agent inherits the CLI's login and configuration. Stderr can carry auth diagnostics, so
  // none of it reaches Cerium's logs.
  const child = yield* spawner
    .spawn(
      ChildProcess.make(command.executable, [...command.args], {
        cwd: command.cwd,
        stderr: "ignore",
        ...(command.env === undefined ? {} : { extendEnv: true, env: command.env }),
      }),
    )
    .pipe(Effect.mapError((cause) => failure(`Could not start the ${harness.label} ACP agent`, cause)));

  const outgoing = yield* Queue.unbounded<string, Cause.Done>();
  const exited = yield* Deferred.make<HarnessFailure>();
  const pending = new Map<number, Deferred.Deferred<unknown, AcpError | HarnessFailure>>();
  let nextId = 1;
  let closed = false;
  const close = (message: string) =>
    Effect.suspend(() => {
      // Set before anything waiting on the exit wakes, so they all see the connection closed.
      closed = true;
      return Deferred.succeed(exited, failure(message));
    });

  const sendUnsafe = (message: object) => {
    Queue.offerUnsafe(outgoing, JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  };
  const respondUnsafe = (id: RequestId, result: unknown) => sendUnsafe({ id, result });
  const respond = (id: RequestId, result: unknown) => Effect.sync(() => respondUnsafe(id, result));
  const reject = (id: RequestId) =>
    Effect.sync(() =>
      sendUnsafe({ id, error: { code: ErrorCode.methodNotFound, message: "Unsupported client method" } }),
    );
  let receive = ({ id }: Incoming): Effect.Effect<void> => (id === undefined ? Effect.void : reject(id));

  const dispatch = (line: string) =>
    Effect.suspend(() => {
      const message = record(parse(line));
      if (message?.["jsonrpc"] !== "2.0") return Effect.void;
      const { id, method, params, error, result } = message;
      if (typeof method === "string") {
        return receive({
          method,
          params,
          ...(typeof id === "number" || typeof id === "string" ? { id } : {}),
        });
      }
      const response = typeof id === "number" ? pending.get(id) : undefined;
      if (response === undefined) return Effect.void;
      const problem = record(error);
      if (problem === undefined) return Deferred.succeed(response, result);
      const code = typeof problem["code"] === "number" ? problem["code"] : ErrorCode.internal;
      return Deferred.fail(
        response,
        new AcpError({ code, message: string(problem["message"]) ?? "ACP error" }),
      );
    });

  yield* Stream.fromQueue(outgoing).pipe(
    Stream.encodeText,
    Stream.run(child.stdin),
    Effect.catch(() => close(`The ${harness.label} ACP input closed unexpectedly`)),
    Effect.forkScoped,
  );
  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach(dispatch),
    Effect.matchEffect({
      onSuccess: () => close(`The ${harness.label} ACP process exited`),
      onFailure: () => close(`The ${harness.label} ACP stream ended unexpectedly`),
    }),
    Effect.forkScoped,
  );
  // Let the agent stop its workers and finish writing session state before the platform kills it.
  yield* Effect.addFinalizer(() =>
    Queue.end(outgoing).pipe(
      Effect.andThen(Deferred.await(exited)),
      Effect.timeout(SHUTDOWN_GRACE),
      Effect.ignore,
    ),
  );

  /** Sends a request now and hands back its response to await, which fails if the agent exits. */
  const beginRequest = (method: string, params: unknown) =>
    Effect.gen(function* () {
      const id = nextId++;
      const response = yield* Deferred.make<unknown, AcpError | HarnessFailure>();
      pending.set(id, response);
      sendUnsafe({ id, method, params });
      return {
        awaitResponse: Deferred.await(response).pipe(
          Effect.raceFirst(Deferred.await(exited).pipe(Effect.flatMap(Effect.fail))),
          Effect.ensuring(Effect.sync(() => pending.delete(id))),
        ),
      };
    });

  const request = (method: string, params: unknown) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(beginRequest(method, params), ({ awaitResponse }) => restore(awaitResponse)),
    );

  /** A request that must be answered promptly, such as session setup or a config change. */
  const query = (method: string, params: unknown, timeout: Duration.Input = QUERY_TIMEOUT) =>
    request(method, params).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(failure(`${harness.label} did not respond to \`${method}\``)),
      }),
    );

  /** What a failed request reads as to the user. */
  const refused = (method: string) => (error: AcpError | HarnessFailure) =>
    error._tag === "HarnessFailure"
      ? error
      : (harness.refused?.(method, error) ??
        failure(`${harness.label} refused \`${method}\`: ${error.message}`, error));

  const raw = yield* query("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "cerium", title: "Cerium", version: "0.0.0" },
    clientCapabilities: {},
    ...(initialize.meta === undefined ? {} : { _meta: initialize.meta }),
  }).pipe(Effect.mapError(refused("initialize")));
  const initialized = record(raw);
  if (initialized?.["protocolVersion"] !== 1) {
    return yield* failure(`${harness.label} did not negotiate ACP version 1`);
  }

  return {
    harness,
    agent: agentInfo(initialized),
    failure,
    beginRequest,
    request,
    query,
    /** `query`, with the agent's refusal turned into the `HarnessFailure` the user sees. */
    call: (method: string, params: unknown, timeout?: Duration.Input) =>
      query(method, params, timeout).pipe(Effect.mapError(refused(method))),
    refused,
    notify: (method: string, params: unknown) => Effect.sync(() => sendUnsafe({ method, params })),
    respond,
    /** `respond` for callbacks outside Effect, such as timers. */
    respondUnsafe,
    reject,
    /** Replaces the handler for the agent's requests and notifications. Unhandled requests are refused. */
    onMessage: (handler: (message: Incoming) => Effect.Effect<void>) => {
      receive = handler;
    },
    /** Resolves, with the failure that explains it, once the agent has gone. */
    exited: Deferred.await(exited),
    isClosed: () => closed,
  };
});

export type AcpConnection = Effect.Success<ReturnType<typeof connect>>;
