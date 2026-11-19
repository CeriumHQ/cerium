import type { HarnessFailure } from "@cerium/harness";
import { Cause, Deferred, Effect, Queue, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { failure } from "./manifest.ts";

export const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

export const string = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

type RequestId = string | number;
export type Incoming = { readonly method: string; readonly params: unknown; readonly id?: RequestId };

export class AcpError extends Schema.TaggedError<AcpError>()("AcpError", {
  code: Schema.Finite,
  message: Schema.String,
}) {}

export const needsLogin = (error: AcpError | HarnessFailure) =>
  error._tag === "AcpError" && error.code === -32000;

const parseLine = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export const callFailure = (method: string) => (cause: AcpError | HarnessFailure) =>
  cause._tag === "HarnessFailure"
    ? cause
    : failure(`Antigravity refused \`${method}\`: ${cause.message}`, cause);

/** One ACP v1 JSON-RPC connection over the subprocess's stdin and stdout. */
export const connect = Effect.fn("Antigravity.connect")(function* (
  executable: string,
  cwd: string,
  flags: ReadonlyArray<string> = [],
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // The subprocess inherits the CLI's login and configuration. Stderr can contain auth diagnostics.
  const child = yield* spawner
    .spawn(ChildProcess.make(executable, ["acp", "--stdio", ...flags], { cwd, stderr: "ignore" }))
    .pipe(Effect.mapError((cause) => failure("Could not start `agy acp`", cause)));

  const outgoing = yield* Queue.unbounded<string, Cause.Done>();
  const exited = yield* Deferred.make<HarnessFailure>();
  const pending = new Map<number, Deferred.Deferred<unknown, AcpError | HarnessFailure>>();
  let nextId = 1;

  const send = (message: object) =>
    Queue.offer(outgoing, JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n").pipe(Effect.asVoid);
  const respond = (id: RequestId, result: unknown) => send({ id, result });
  const reject = (id: RequestId) =>
    send({ id, error: { code: -32601, message: "Unsupported client method" } });
  let receive = ({ id }: Incoming): Effect.Effect<void> => (id === undefined ? Effect.void : reject(id));

  const dispatch = (line: string) =>
    Effect.gen(function* () {
      if (!line.trim()) return;
      const message = record(yield* parseLine(line));
      if (message?.["jsonrpc"] !== "2.0") return;
      const { id, method, params, error, result } = message;
      if (typeof method === "string") {
        yield* receive({
          method,
          params,
          ...(typeof id === "number" || typeof id === "string" ? { id } : {}),
        });
        return;
      }
      if (typeof id !== "number") return;
      const response = pending.get(id);
      if (response === undefined) return;
      const problem = record(error);
      if (problem !== undefined) {
        const code = typeof problem["code"] === "number" ? problem["code"] : -32603;
        yield* Deferred.fail(
          response,
          new AcpError({ code, message: string(problem["message"]) ?? "ACP error" }),
        );
      } else {
        yield* Deferred.succeed(response, result);
      }
    });

  yield* Stream.fromQueue(outgoing).pipe(
    Stream.encodeText,
    Stream.run(child.stdin),
    Effect.catch(() => Deferred.succeed(exited, failure("The Antigravity ACP input closed unexpectedly"))),
    Effect.forkScoped,
  );
  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach(dispatch),
    Effect.matchEffect({
      onSuccess: () => Deferred.succeed(exited, failure("The Antigravity ACP process exited")),
      onFailure: () => Deferred.succeed(exited, failure("The Antigravity ACP stream ended unexpectedly")),
    }),
    Effect.forkScoped,
  );
  // Let ACP stop its workers and finish writing session state before the platform kills the child.
  yield* Effect.addFinalizer(() =>
    Queue.end(outgoing).pipe(
      Effect.andThen(Deferred.await(exited)),
      Effect.timeout("3 seconds"),
      Effect.ignore,
    ),
  );

  const beginRequest = (method: string, params: unknown) =>
    Effect.gen(function* () {
      const id = nextId++;
      const response = yield* Deferred.make<unknown, AcpError | HarnessFailure>();
      pending.set(id, response);
      yield* send({ id, method, params });
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

  const query = (method: string, params: unknown) =>
    request(method, params).pipe(
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () => Effect.fail(failure(`Antigravity did not respond to \`${method}\``)),
      }),
    );

  const initialized = yield* query("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "cerium", title: "Cerium", version: "0.0.0" },
    clientCapabilities: {},
  }).pipe(Effect.mapError(callFailure("initialize")));
  if (record(initialized)?.["protocolVersion"] !== 1) {
    return yield* failure("Antigravity did not negotiate ACP version 1");
  }

  return {
    capabilities: record(record(initialized)?.["agentCapabilities"]),
    beginRequest,
    request,
    query,
    exited: Deferred.await(exited),
    onMessage: (handler: typeof receive) => {
      receive = handler;
    },
    notify: (method: string, params: unknown) => send({ method, params }),
    respond,
    reject,
  };
});
