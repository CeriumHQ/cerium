import { CeriumRpcs } from "@cerium/rpc";
import { Effect, Layer, Schema } from "effect";
import { Atom, AtomRpc, type AtomRegistry } from "effect/reactivity";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import { drivenMachine, onMachineChange } from "./machine.ts";
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

/** Whether the UI is connected to the machine it drives right now. */
export const connectionAtom = Atom.make<ConnectionState>("connecting").pipe(Atom.keepAlive);

/** Whether the UI is connected to this computer's own backend right now. */
export const localConnectionAtom = Atom.make<ConnectionState>("connecting").pipe(Atom.keepAlive);

/** Where a connection goes: always this computer's backend, or whichever machine the window drives. */
type Target = "local" | "driven";

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
  }).pipe(
    Effect.mapError(
      (cause) => new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) }),
    ),
  );

/** Closed to switch machines; the client then reopens on the new one. */
const SWITCHING = 4000;
/** How long a switch may take before the machine counts as unreachable. */
const SWITCH_TIMEOUT_MS = 10_000;

/** Whether the driven connection is closing to switch machines, which isn't losing it. */
let switching = false;

const backendSocket = (
  target: Target,
  registry: AtomRegistry.AtomRegistry,
  state: Atom.Writable<ConnectionState>,
) =>
  Layer.effect(
    Socket.Socket,
    Effect.gen(function* () {
      let current: WebSocket | undefined;
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
        Effect.acquireRelease(
          openSocket(target).pipe(Effect.tap((ws) => Effect.sync(() => (current = ws as WebSocket)))),
          (ws) => Effect.sync(() => ws.close(1000)),
        ),
      );
    }),
  );

const protocol = (target: Target, registry: AtomRegistry.AtomRegistry) => {
  const state = target === "local" ? localConnectionAtom : connectionAtom;
  return RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
    Layer.provide(backendSocket(target, registry, state)),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
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
  group: CeriumRpcs,
  protocol: (get) => protocol("driven", get.registry),
}) {}

/**
 * This computer's own backend, whatever the window drives: its Cerium account, and whether its
 * agents are working, which keeps it awake.
 */
export class LocalBackend extends AtomRpc.Service<LocalBackend>()("cerium/ui/LocalBackend", {
  group: CeriumRpcs,
  protocol: (get) => protocol("local", get.registry),
}) {}
