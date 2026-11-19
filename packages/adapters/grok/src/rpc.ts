import { HarnessFailure } from "@cerium/harness";
import { Deferred, Effect, Queue, Stream, type Cause } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

type JsonObject = Readonly<Record<string, unknown>>;
export type RpcId = number | string;

export const object = (value: unknown): JsonObject | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
export const string = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined);
export const array = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

export const failure = (message: string, cause?: unknown) =>
  new HarnessFailure({ provider: "grok", message, cause });

export interface Incoming {
  readonly method: string;
  readonly id?: RpcId;
  readonly params: JsonObject;
}

export const connect = Effect.fn("GrokAdapter.connect")(function* (
  executable: string,
  cwd: string,
  sandbox?: "off" | "workspace" | "read-only",
  includeUserMcpServers = true,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(executable, ["--no-auto-update", "agent", "--no-leader", "stdio"], {
        cwd,
        extendEnv: true,
        env: {
          GROK_DISABLE_AUTOUPDATER: "1",
          GROK_TELEMETRY_ENABLED: "0",
          GROK_STORAGE_MODE: "local",
          GROK_WORKFLOWS: "0",
          GROK_GOAL: "0",
          GROK_SANDBOX_AUTO_ALLOW_BASH: "0",
          ...(includeUserMcpServers
            ? {}
            : {
                GROK_CLAUDE_MCPS_ENABLED: "0",
                GROK_CURSOR_MCPS_ENABLED: "0",
                GROK_CODEX_MCPS_ENABLED: "0",
                GROK_MANAGED_MCPS_ENABLED: "0",
                GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: "0",
              }),
          ...(sandbox === undefined ? {} : { GROK_SANDBOX: sandbox }),
        },
      }),
    )
    .pipe(Effect.mapError((cause) => failure("Could not start Grok Build ACP", cause)));

  const outgoing = yield* Queue.unbounded<string, Cause.Done>();
  const exited = yield* Deferred.make<void>();
  const pending = new Map<number, Deferred.Deferred<unknown, HarnessFailure>>();
  let nextId = 1;
  let onIncoming: ((message: Incoming) => void) | undefined;
  let closed = false;
  const closedError = failure("The Grok Build ACP connection closed");
  const send = (message: object) => {
    if (!closed) Queue.offerUnsafe(outgoing, JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  };
  const respond = (id: RpcId, result: unknown) => send({ id, result });
  const unsupported = (id: RpcId) =>
    send({ id, error: { code: -32601, message: "Unsupported Grok Build client request" } });

  const dispatch = (line: string) =>
    Effect.sync(() => {
      let frame;
      try {
        frame = object(JSON.parse(line));
      } catch {
        return;
      }
      if (frame?.["jsonrpc"] !== "2.0") return;
      const id = frame["id"];
      const method = string(frame["method"]);
      if (method !== undefined) {
        const requestId = typeof id === "number" || typeof id === "string" ? { id } : {};
        if (onIncoming !== undefined) {
          onIncoming({ method, ...requestId, params: object(frame["params"]) ?? {} });
        } else if ("id" in requestId) {
          unsupported(requestId.id);
        }
        return;
      }
      if (typeof id !== "number") return;
      const waiting = pending.get(id);
      if (waiting === undefined) return;
      pending.delete(id);
      const error = object(frame["error"]);
      if (error !== undefined) {
        // Data can include local auth or configuration details. Keep only the JSON-RPC code.
        const code = typeof error["code"] === "number" ? error["code"] : undefined;
        Deferred.doneUnsafe(
          waiting,
          Effect.fail(
            failure(
              code === undefined
                ? "Grok Build rejected the ACP request"
                : `Grok Build rejected the ACP request (${code})`,
              code,
            ),
          ),
        );
      } else {
        Deferred.doneUnsafe(waiting, Effect.succeed(frame["result"]));
      }
    });

  const finish = Effect.sync(() => {
    closed = true;
    for (const waiting of pending.values()) Deferred.doneUnsafe(waiting, Effect.fail(closedError));
    pending.clear();
    Deferred.doneUnsafe(exited, Effect.void);
  });

  yield* Stream.fromQueue(outgoing).pipe(
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
    Effect.ensuring(finish),
    Effect.forkScoped,
  );
  // Drain stderr without putting CLI diagnostics or credentials into the event log.
  yield* Stream.runDrain(handle.stderr).pipe(Effect.ignore, Effect.forkScoped);
  yield* Effect.addFinalizer(() =>
    Queue.end(outgoing).pipe(
      Effect.andThen(Deferred.await(exited)),
      Effect.timeout("2 seconds"),
      Effect.ignore,
    ),
  );

  const request = (method: string, params: JsonObject) =>
    Effect.gen(function* () {
      if (closed) return yield* closedError;
      const id = nextId++;
      const response = yield* Deferred.make<unknown, HarnessFailure>();
      pending.set(id, response);
      send({ id, method, params });
      return yield* Deferred.await(response).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(id);
          }),
        ),
      );
    });

  return {
    request,
    respond,
    unsupported,
    notify: (method: string, params: JsonObject) =>
      Effect.sync(() => send({ method, params })).pipe(
        Effect.filterOrFail(
          () => !closed,
          () => closedError,
        ),
      ),
    receive: (handler: (message: Incoming) => void) => {
      onIncoming = handler;
    },
    exited: Deferred.await(exited),
    isClosed: () => closed,
  };
});

export type GrokConnection = Effect.Success<ReturnType<typeof connect>>;
