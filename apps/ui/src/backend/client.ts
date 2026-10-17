import { CeriumRpcs } from "@cerium/rpc";
import { Effect, Layer, Schema } from "effect";
import { Atom, AtomRpc, type AtomRegistry } from "effect/reactivity";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import { shellBridge, type BackendConnection } from "./shell.ts";

export class BackendUnreachable extends Schema.TaggedError<BackendUnreachable>()("BackendUnreachable", {
  message: Schema.String,
}) {}

/** The packaged app gets its connection from the shell; development asks the Vite dev server. */
const connection = Effect.tryPromise({
  try: async (): Promise<BackendConnection> => {
    const fromShell = await shellBridge()?.backendConnection?.();
    if (fromShell) return fromShell;
    const response = await fetch("/__cerium/connection", { cache: "no-store" });
    if (!response.ok) throw new BackendUnreachable({ message: await response.text() });
    return (await response.json()) as BackendConnection;
  },
  catch: (cause) =>
    cause instanceof BackendUnreachable
      ? cause
      : new BackendUnreachable({ message: `Couldn't reach the Cerium backend: ${String(cause)}` }),
});

export type ConnectionState = "connecting" | "connected" | "unreachable";

/** Whether the UI is connected to the backend right now. */
export const connectionAtom = Atom.make<ConnectionState>("connecting").pipe(Atom.keepAlive);

/**
 * Opens the socket, re-reading the connection each time so a restarted dev backend with a new port
 * and token just works. A backend that isn't up yet counts as a failed open, which the client retries.
 */
const openSocket = Effect.gen(function* () {
  const makeWebSocket = yield* Socket.WebSocketConstructor;
  const { url, token } = yield* connection;
  return makeWebSocket(`${url}?token=${encodeURIComponent(token)}`);
}).pipe(
  Effect.mapError(
    (cause) => new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) }),
  ),
);

const BackendSocket = Layer.effect(
  Socket.Socket,
  Socket.fromWebSocket(Effect.acquireRelease(openSocket, (ws) => Effect.sync(() => ws.close(1000)))),
);

const protocol = (registry: AtomRegistry.AtomRegistry) =>
  RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
    Layer.provide(BackendSocket),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(
      Layer.succeed(RpcClient.ConnectionHooks, {
        onConnect: Effect.sync(() => registry.set(connectionAtom, "connected")),
        onDisconnect: Effect.sync(() => registry.set(connectionAtom, "unreachable")),
      }),
    ),
  );

/** The backend's RPC client, wired into atoms. */
export class Backend extends AtomRpc.Service<Backend>()("cerium/ui/Backend", {
  group: CeriumRpcs,
  protocol: (get) => protocol(get.registry),
}) {}
