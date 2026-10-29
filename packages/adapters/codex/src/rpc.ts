import { HarnessFailure } from "@cerium/harness";
import { Deferred, Duration, Effect, Option, Queue, Schema, Stream, type Cause } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { InitializeParams } from "./protocol/InitializeParams.ts";
import type { InitializeResponse } from "./protocol/InitializeResponse.ts";
import type { RequestId } from "./protocol/RequestId.ts";
import type { ServerNotification } from "./protocol/ServerNotification.ts";
import type { ServerRequest } from "./protocol/ServerRequest.ts";
import type { ConfigReadParams } from "./protocol/v2/ConfigReadParams.ts";
import type { ConfigReadResponse } from "./protocol/v2/ConfigReadResponse.ts";
import type { ConfigRequirementsReadResponse } from "./protocol/v2/ConfigRequirementsReadResponse.ts";
import type { ConfigValueWriteParams } from "./protocol/v2/ConfigValueWriteParams.ts";
import type { ConfigWriteResponse } from "./protocol/v2/ConfigWriteResponse.ts";
import type { GetAccountParams } from "./protocol/v2/GetAccountParams.ts";
import type { GetAccountRateLimitsParams } from "./protocol/v2/GetAccountRateLimitsParams.ts";
import type { GetAccountRateLimitsResponse } from "./protocol/v2/GetAccountRateLimitsResponse.ts";
import type { GetAccountResponse } from "./protocol/v2/GetAccountResponse.ts";
import type { ListMcpServerStatusParams } from "./protocol/v2/ListMcpServerStatusParams.ts";
import type { ListMcpServerStatusResponse } from "./protocol/v2/ListMcpServerStatusResponse.ts";
import type { ModelListParams } from "./protocol/v2/ModelListParams.ts";
import type { ModelListResponse } from "./protocol/v2/ModelListResponse.ts";
import type { ThreadCompactStartParams } from "./protocol/v2/ThreadCompactStartParams.ts";
import type { ThreadCompactStartResponse } from "./protocol/v2/ThreadCompactStartResponse.ts";
import type { ThreadForkParams } from "./protocol/v2/ThreadForkParams.ts";
import type { ThreadForkResponse } from "./protocol/v2/ThreadForkResponse.ts";
import type { ThreadListParams } from "./protocol/v2/ThreadListParams.ts";
import type { ThreadListResponse } from "./protocol/v2/ThreadListResponse.ts";
import type { ThreadResumeParams } from "./protocol/v2/ThreadResumeParams.ts";
import type { ThreadResumeResponse } from "./protocol/v2/ThreadResumeResponse.ts";
import type { ThreadStartParams } from "./protocol/v2/ThreadStartParams.ts";
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse.ts";
import type { ThreadTurnsListParams } from "./protocol/v2/ThreadTurnsListParams.ts";
import type { ThreadTurnsListResponse } from "./protocol/v2/ThreadTurnsListResponse.ts";
import type { SkillsConfigWriteParams } from "./protocol/v2/SkillsConfigWriteParams.ts";
import type { SkillsConfigWriteResponse } from "./protocol/v2/SkillsConfigWriteResponse.ts";
import type { SkillsListParams } from "./protocol/v2/SkillsListParams.ts";
import type { SkillsListResponse } from "./protocol/v2/SkillsListResponse.ts";
import type { TurnInterruptParams } from "./protocol/v2/TurnInterruptParams.ts";
import type { TurnInterruptResponse } from "./protocol/v2/TurnInterruptResponse.ts";
import type { TurnStartParams } from "./protocol/v2/TurnStartParams.ts";
import type { TurnStartResponse } from "./protocol/v2/TurnStartResponse.ts";

// A JSON-RPC connection to one `codex app-server` child over stdio (one JSON message per line).

/** The client requests the adapter sends: params and result for each method. */
interface Methods {
  initialize: readonly [InitializeParams, InitializeResponse];
  "account/read": readonly [GetAccountParams, GetAccountResponse];
  "account/rateLimits/read": readonly [GetAccountRateLimitsParams, GetAccountRateLimitsResponse];
  "config/read": readonly [ConfigReadParams, ConfigReadResponse];
  "config/value/write": readonly [ConfigValueWriteParams, ConfigWriteResponse];
  "configRequirements/read": readonly [undefined, ConfigRequirementsReadResponse];
  "mcpServerStatus/list": readonly [ListMcpServerStatusParams, ListMcpServerStatusResponse];
  "model/list": readonly [ModelListParams, ModelListResponse];
  "skills/list": readonly [SkillsListParams, SkillsListResponse];
  "skills/config/write": readonly [SkillsConfigWriteParams, SkillsConfigWriteResponse];
  "thread/start": readonly [ThreadStartParams, ThreadStartResponse];
  "thread/resume": readonly [ThreadResumeParams, ThreadResumeResponse];
  "thread/fork": readonly [ThreadForkParams, ThreadForkResponse];
  "thread/list": readonly [ThreadListParams, ThreadListResponse];
  "thread/compact/start": readonly [ThreadCompactStartParams, ThreadCompactStartResponse];
  "thread/turns/list": readonly [ThreadTurnsListParams, ThreadTurnsListResponse];
  "turn/start": readonly [TurnStartParams, TurnStartResponse];
  "turn/interrupt": readonly [TurnInterruptParams, TurnInterruptResponse];
}

/** The app-server rejected a request. */
export class RpcError extends Schema.TaggedError<RpcError>()("RpcError", {
  method: Schema.String,
  code: Schema.Finite,
  message: Schema.String,
  /** The error response as received. */
  response: Schema.Unknown,
}) {}

export type Incoming =
  | { readonly _tag: "Notification"; readonly message: ServerNotification }
  | { readonly _tag: "Request"; readonly message: ServerRequest };

export interface AppServer {
  request<M extends keyof Methods>(
    method: M,
    params: Methods[M][0],
  ): Effect.Effect<Methods[M][1], RpcError | HarnessFailure>;
  respond(id: RequestId, result: unknown): Effect.Effect<void>;
  respondError(id: RequestId, code: number, message: string): Effect.Effect<void>;
  /** Notifications and server requests in arrival order. Single consumer; ends when the process exits. */
  readonly incoming: Stream.Stream<Incoming>;
  /** Resolves once the process has exited. */
  readonly exited: Effect.Effect<void>;
  /** The server's `$CODEX_HOME`, as its handshake reported it. */
  readonly codexHome: string;
}

const failure = (message: string) => (cause: unknown) =>
  new HarnessFailure({ provider: "codex", message, cause });

const isRequest = Schema.is(
  Schema.Struct({ id: Schema.Union([Schema.String, Schema.Finite]), method: Schema.String }),
);
const isNotification = Schema.is(Schema.Struct({ method: Schema.String }));
/** Responses to the adapter's own requests, whose ids are numbers. */
const isResponse = Schema.is(Schema.Struct({ id: Schema.Finite }));
const isError = Schema.is(
  Schema.Struct({ error: Schema.Struct({ code: Schema.Finite, message: Schema.String }) }),
);
const parseLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** High-volume notifications the translator never reads. */
const OPTED_OUT = [
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "command/exec/outputDelta",
  "process/outputDelta",
  "thread/realtime/outputAudio/delta",
];

const STDERR_LINES = 20;
const SHUTDOWN_GRACE = Duration.seconds(3);

/**
 * Spawns `codex app-server` and completes the initialize handshake. The process lives until the
 * enclosing scope closes. Closing its stdin first lets it exit on its own (in ~20 ms) and finish
 * writing its thread; a process that does not exit in time is killed with everything it started.
 * While a process is alive its thread cannot be resumed elsewhere ("already has an active writer").
 */
export const connect = Effect.fn("CodexAdapter.connect")(function* (executablePath: string, cwd?: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner
    .spawn(ChildProcess.make(executablePath, ["app-server"], cwd === undefined ? {} : { cwd }))
    .pipe(Effect.mapError(failure("Could not start `codex app-server`")));

  const outgoing = yield* Queue.unbounded<string, Cause.Done>();
  const incoming = yield* Queue.unbounded<Incoming, Cause.Done>();
  const exited = yield* Deferred.make<void>();
  /** The adapter's requests awaiting their response, by id. */
  const pending = new Map<
    number,
    { readonly method: string; readonly response: Deferred.Deferred<unknown, RpcError | HarnessFailure> }
  >();
  const stderr: Array<string> = [];
  let nextId = 1;

  const send = (message: object) => Queue.offer(outgoing, JSON.stringify(message)).pipe(Effect.asVoid);

  // Messages are typed by the generated protocol once their envelope is recognised.
  const dispatch = (line: string) =>
    Effect.suspend((): Effect.Effect<unknown> => {
      const message: unknown = Option.getOrUndefined(parseLine(line));
      if (isRequest(message)) {
        return Queue.offer(incoming, { _tag: "Request", message: message as unknown as ServerRequest });
      }
      if (isNotification(message)) {
        return Queue.offer(incoming, {
          _tag: "Notification",
          message: message as unknown as ServerNotification,
        });
      }
      if (!isResponse(message)) return Effect.void;
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (waiting === undefined) return Effect.void;
      if (isError(message)) {
        const { code, message: text } = message.error;
        return Deferred.fail(
          waiting.response,
          new RpcError({ method: waiting.method, code, message: text, response: message }),
        );
      }
      return Deferred.succeed(waiting.response, (message as { readonly result?: unknown }).result);
    });

  const closed = Effect.gen(function* () {
    const reason = new HarnessFailure({
      provider: "codex",
      message: "The Codex app-server exited",
      cause: stderr.join("\n"),
    });
    for (const waiting of pending.values()) yield* Deferred.fail(waiting.response, reason);
    pending.clear();
    yield* Queue.end(incoming);
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
  // Drained so the pipe never fills; the tail explains an unexpected exit.
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
  // Registered after the fibers above, so it runs while the stdin writer is still alive.
  yield* Effect.addFinalizer(() =>
    Queue.end(outgoing).pipe(
      Effect.andThen(Deferred.await(exited)),
      Effect.timeout(SHUTDOWN_GRACE),
      Effect.ignore,
    ),
  );

  const request = <M extends keyof Methods>(method: M, params: Methods[M][0]) =>
    Effect.gen(function* () {
      const id = nextId++;
      const response = yield* Deferred.make<unknown, RpcError | HarnessFailure>();
      pending.set(id, { method, response });
      yield* send({ id, method, params });
      // Results are trusted to match the generated protocol of the version the adapter was tested with.
      return (yield* Deferred.await(response)) as Methods[M][1];
    });

  const { codexHome } = yield* request("initialize", {
    clientInfo: { name: "cerium", title: "Cerium", version: "0.0.0" },
    capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: OPTED_OUT },
  }).pipe(Effect.mapError(failure("The Codex app-server did not initialize")));
  yield* send({ method: "initialized" });
  const server: AppServer = {
    request,
    respond: (id, result) => send({ id, result }),
    respondError: (id, code, message) => send({ id, error: { code, message } }),
    incoming: Stream.fromQueue(incoming),
    exited: Deferred.await(exited),
    codexHome,
  };
  return server;
});
