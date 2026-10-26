import {
  Account,
  deviceHandlers,
  noBrowserHosting,
  openTunnel,
  refuseEffortRouterKey,
} from "@cerium/account";
import { DeviceRpcs, MachineRpcs, TUNNEL_HELLO } from "@cerium/rpc";
import { Effect, Layer, Schedule, Schema, Stream } from "effect";
import { Atom, AtomRpc, type AtomRegistry } from "effect/reactivity";
import { RpcClient, RpcSerialization, RpcTest } from "effect/rpc";
import { Socket } from "effect/socket";

import { WebDevice } from "../web/device.ts";
import { liveness, type ConnectionState, type Liveness } from "./liveness.ts";
import { drivenMachine, onMachineChange } from "./machine.ts";
import { shellBridge, type BackendConnection } from "./shell.ts";
import { WEB } from "./target.ts";

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

export type { ConnectionState };

/** Whether the UI is connected to the machine it drives right now. */
export const connectionAtom = Atom.make<ConnectionState>("connecting").pipe(Atom.keepAlive);

/**
 * Which connection to the driven machine reads belong to. It moves on with every change of
 * `connectionAtom` but a line dropping, so a read made again when it moves keeps its value while the
 * line comes back, then reads afresh what changed meanwhile, which never arrives.
 */
export const connectionEpochAtom = Atom.make(0).pipe(Atom.keepAlive);

/**
 * Whether the UI is connected to this device's own side right now: a desktop's backend, or for the
 * web client the page itself, which always is.
 */
export const localConnectionAtom = Atom.make<ConnectionState>(WEB ? "connected" : "connecting").pipe(
  Atom.keepAlive,
);

/** Where a connection goes: always this computer's backend, or whichever machine the window drives. */
type Target = "local" | "driven";

const openFailed = (cause: unknown) =>
  new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) });

/**
 * Opens a socket, re-reading the connection each time so a restarted dev backend with a new port
 * and token just works. A backend that isn't up yet counts as a failed open, which the client
 * retries. Another machine is reached through this computer's backend at `/remote`.
 */
const openSocket = (target: Target) =>
  Effect.gen(function* () {
    const makeWebSocket = yield* Socket.WebSocketConstructor;
    const { url, token } = yield* connection;
    const machine = target === "driven" ? drivenMachine() : undefined;
    const query = `token=${encodeURIComponent(token)}`;
    return makeWebSocket(
      machine === undefined
        ? `${url}?${query}`
        : `${url.replace(/\/rpc$/, "/remote")}?${query}&machine=${encodeURIComponent(machine.id)}`,
    );
  }).pipe(Effect.mapError(openFailed));

/**
 * The web client reaches the machine it drives through a tunnel on its own relay connection,
 * open once the machine answers; with none chosen yet, there's nothing to open.
 */
const openTunnelSocket = Effect.gen(function* () {
  const machine = drivenMachine();
  if (machine === undefined) return yield* openFailed("No computer is chosen.");
  return yield* openTunnel(yield* Account, machine.id, { hello: TUNNEL_HELLO });
});

/** Closed to switch machines; the client then reopens on the new one. */
const SWITCHING = 4000;
/**
 * How long the driven machine may stay silent before the connection counts as lost. Another machine
 * answers through the relay, where a moment's stall on either computer is no reason to give up.
 */
const DRIVEN_PING_TIMEOUT = "15 seconds";

const backendSocket = <R>(
  open: Effect.Effect<Socket.WebSocketLike, Socket.SocketError, R>,
  target: Target,
  live: Liveness,
) =>
  Layer.effect(
    Socket.Socket,
    Effect.gen(function* () {
      let current: Socket.WebSocketLike | undefined;
      if (target === "driven") {
        const stop = onMachineChange(() => {
          live.restart();
          current?.close(SWITCHING, "Switching machines");
        });
        yield* Effect.addFinalizer(() => Effect.sync(stop));
      }
      return yield* Socket.fromWebSocket(
        Effect.acquireRelease(open.pipe(Effect.tap((ws) => Effect.sync(() => (current = ws)))), (ws) =>
          Effect.sync(() => ws.close(1000)),
        ),
      );
    }),
  );

/**
 * A desktop's UI opens WebSockets to its backend; the web client opens tunnels on the page's relay
 * connection, which every client shares.
 */
const socketLayer = (target: Target, live: Liveness) =>
  WEB
    ? backendSocket(openTunnelSocket, target, live).pipe(Layer.provide(WebDevice))
    : backendSocket(openSocket(target), target, live).pipe(
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
      );

/**
 * A call made while the line comes back waits for it, rather than failing on the connection that
 * dropped: a message sent the moment a phone is back in the app goes once the machine answers.
 */
const waitingOutReconnects = (live: Liveness) =>
  Layer.effect(
    RpcClient.Protocol,
    Effect.gen(function* () {
      const protocol = yield* RpcClient.Protocol;
      return RpcClient.Protocol.of({
        ...protocol,
        send: (clientId, request, transferables) =>
          request._tag === "Request"
            ? Effect.andThen(live.settled, protocol.send(clientId, request, transferables))
            : protocol.send(clientId, request, transferables),
      });
    }),
  );

const protocol = (target: Target, registry: AtomRegistry.AtomRegistry) => {
  const live =
    target === "local"
      ? liveness(registry, localConnectionAtom)
      : liveness(registry, connectionAtom, connectionEpochAtom);
  return RpcClient.layerProtocolSocket({
    retryTransientErrors: true,
    retryPolicy: Schedule.forever.pipe(Schedule.modifyDelay(() => Effect.sync(live.nextRetry))),
    ...(target === "driven" ? { pingTimeout: DRIVEN_PING_TIMEOUT } : {}),
  }).pipe(
    Layer.provide(socketLayer(target, live)),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(
      Layer.succeed(RpcClient.ConnectionHooks, {
        onConnect: Effect.sync(live.connected),
        onDisconnect: Effect.sync(live.lost),
      }),
    ),
    (socket) => waitingOutReconnects(live).pipe(Layer.provide(socket)),
  );
};

/** The RPC client of the machine the window drives, wired into atoms. */
export class Backend extends AtomRpc.Service<Backend>()("cerium/ui/Backend", {
  group: MachineRpcs,
  protocol: (get) => protocol("driven", get.registry),
}) {}

/** Names the device client's service, which each build makes its own way. */
interface LocalBackendId {
  readonly id: "cerium/ui/LocalBackend";
}

/** A desktop's backend answers the device RPCs over its socket. */
const desktopDevice = () =>
  AtomRpc.Service<LocalBackendId>()("cerium/ui/LocalBackend", {
    group: DeviceRpcs,
    protocol: (get) => protocol("local", get.registry),
  });

/** The web client answers them itself, in the page; a browser runs no agents. */
const webDevice = () =>
  AtomRpc.Service<LocalBackendId>()("cerium/ui/LocalBackend", {
    group: DeviceRpcs,
    protocol: deviceHandlers({
      working: Effect.succeed(Stream.succeed(false)),
      notifications: Effect.succeed(Stream.never),
      saveEffortRouterKey: Effect.succeed(refuseEffortRouterKey),
      browser: Effect.succeed(noBrowserHosting),
    }).pipe(Layer.provideMerge(WebDevice)),
    makeEffect: RpcTest.makeClient(DeviceRpcs, { flatten: true }),
  });

/**
 * This device's own side, whatever the window drives: its Cerium account, the account's threads and
 * whether its own agents are working, which keeps a desktop awake.
 */
export const LocalBackend = WEB ? webDevice() : desktopDevice();
