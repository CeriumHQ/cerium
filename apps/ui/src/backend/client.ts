import { Account, deviceHandlers, openTunnel } from "@cerium/account";
import { DeviceRpcs, MachineRpcs } from "@cerium/rpc";
import { Effect, Layer, Schema, Stream } from "effect";
import { Atom, AtomRpc, type AtomRegistry } from "effect/reactivity";
import { RpcClient, RpcSerialization, RpcTest } from "effect/rpc";
import { Socket } from "effect/socket";

import { WebDevice } from "../web/device.ts";
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

export type ConnectionState = "connecting" | "connected" | "unreachable";

/** Whether the UI is connected to the machine it drives right now. */
export const connectionAtom = Atom.make<ConnectionState>("connecting").pipe(Atom.keepAlive);

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
 * retries. Another machine is reached through this computer's backend at `/remote` (§14.8).
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
 * The web client reaches the machine it drives through a tunnel on its own relay connection
 * (§14.10); with none chosen yet, there's nothing to open.
 */
const openTunnelSocket = Effect.gen(function* () {
  const machine = drivenMachine();
  if (machine === undefined) return yield* openFailed("No computer is chosen.");
  return yield* openTunnel(yield* Account, machine.id);
});

/** Closed to switch machines; the client then reopens on the new one. */
const SWITCHING = 4000;
/** How long a switch may take before the machine counts as unreachable. */
const SWITCH_TIMEOUT_MS = 10_000;

/** Whether the driven connection is closing to switch machines, which isn't losing it. */
let switching = false;

const backendSocket = <R>(
  open: Effect.Effect<Socket.WebSocketLike, Socket.SocketError, R>,
  target: Target,
  registry: AtomRegistry.AtomRegistry,
  state: Atom.Writable<ConnectionState>,
) =>
  Layer.effect(
    Socket.Socket,
    Effect.gen(function* () {
      let current: Socket.WebSocketLike | undefined;
      if (target === "driven") {
        const stop = onMachineChange(() => {
          switching = true;
          registry.set(state, "connecting");
          current?.close(SWITCHING, "Switching machines");
          // A machine that can't be reached never connects: say so after a while.
          setTimeout(() => {
            if (!switching) return;
            switching = false;
            registry.set(state, "unreachable");
          }, SWITCH_TIMEOUT_MS);
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
const socketLayer = (
  target: Target,
  registry: AtomRegistry.AtomRegistry,
  state: Atom.Writable<ConnectionState>,
) =>
  WEB
    ? backendSocket(openTunnelSocket, target, registry, state).pipe(Layer.provide(WebDevice))
    : backendSocket(openSocket(target), target, registry, state).pipe(
        Layer.provide(Socket.layerWebSocketConstructorGlobal),
      );

const protocol = (target: Target, registry: AtomRegistry.AtomRegistry) => {
  const state = target === "local" ? localConnectionAtom : connectionAtom;
  return RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
    Layer.provide(socketLayer(target, registry, state)),
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(
      Layer.succeed(RpcClient.ConnectionHooks, {
        onConnect: Effect.sync(() => {
          if (target === "driven") switching = false;
          registry.set(state, "connected");
        }),
        onDisconnect: Effect.sync(() => {
          // A switch already said it's connecting again.
          if (target === "driven" && switching) return;
          registry.set(state, "unreachable");
        }),
      }),
    ),
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
    protocol: deviceHandlers(Effect.succeed(Stream.succeed(false))).pipe(Layer.provideMerge(WebDevice)),
    makeEffect: RpcTest.makeClient(DeviceRpcs, { flatten: true }),
  });

/**
 * This device's own side, whatever the window drives: its Cerium account, the account's threads and
 * whether its own agents are working, which keeps a desktop awake.
 */
export const LocalBackend = WEB ? webDevice() : desktopDevice();
