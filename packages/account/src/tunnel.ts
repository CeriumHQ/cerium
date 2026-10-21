import {
  FrameJoiner,
  framePieces,
  type ConnectionId,
  type DeviceId,
  type TunnelAddress,
} from "@cerium/protocol";
import { Deferred, Effect, Exit, PubSub, Queue, Stream, type Scope } from "effect";
import { Socket } from "effect/socket";

import type { Account } from "./account.ts";

// Tunnels: a channel through the relay to a desktop of the account, as a WebSocket, so
// `Socket.fromWebSocket` turns it into a socket that reopens like one. A desktop's `/remote` pipe and
// the web client's RPC client both reach machines this way.

/** Close codes a tunnel ends with: the machine can't be reached, or it ended the channel. */
export const CLOSE_UNREACHABLE = 4100;
export const CLOSE_ENDED = 4101;

/** Why a tunnel couldn't reach its machine, written for the user. */
export const unreachableReason: Record<"offline" | "forbidden" | "lost" | "silent", string> = {
  offline: "That computer isn't connected to Cerium's cloud right now.",
  forbidden: "That computer isn't an approved computer of your account.",
  lost: "Lost the connection to Cerium's cloud.",
  silent: "That computer didn't answer.",
};

/** How long opening a tunnel waits for this device's relay connection, and then for the machine. */
const OPEN_WITHIN = "8 seconds";

export interface TunnelOptions {
  /**
   * A frame the machine answers with exactly one frame, such as an RPC ping. When given, the tunnel
   * opens only once that answer arrives, which isn't passed on, so an open tunnel means the machine
   * is there rather than that a frame could be sent.
   */
  readonly hello?: string;
}

const openFailed = (reason: string, kind: "Unknown" | "Timeout" = "Unknown") =>
  new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind, cause: new Error(reason) }) });

type Listener = (event: Socket.WebSocketEvent) => void;
type EventType = "open" | "message" | "error" | "close";

const text = new TextDecoder();

/**
 * One channel, open from the start: its first frame goes to the machine's newest connection and
 * either finds it or comes back undeliverable, which closes the channel.
 */
class TunnelChannel implements Socket.WebSocketLike {
  readyState = 1;
  private readonly listeners: Record<EventType, Map<Listener, boolean>> = {
    open: new Map(),
    message: new Map(),
    error: new Map(),
    close: new Map(),
  };

  private readonly onSend: (data: string) => void;
  private readonly onClose: () => void;

  constructor(onSend: (data: string) => void, onClose: () => void) {
    this.onSend = onSend;
    this.onClose = onClose;
  }

  addEventListener(type: EventType, listener: Listener, options?: { readonly once?: boolean }) {
    this.listeners[type].set(listener, options?.once === true);
  }

  removeEventListener(type: EventType, listener: Listener) {
    this.listeners[type].delete(listener);
  }

  send(data: string | Uint8Array<ArrayBuffer>) {
    if (this.readyState === 1) this.onSend(typeof data === "string" ? data : text.decode(data));
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    this.onClose();
    this.ended(code, reason);
  }

  /** A frame from the machine. */
  received(data: string) {
    if (this.readyState === 1) this.emit("message", { type: "message", data });
  }

  /** The channel ended, from either side. */
  ended(code: number, reason: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { type: "close", code, reason });
  }

  private emit(type: EventType, event: Socket.WebSocketEvent) {
    for (const [listener, once] of [...this.listeners[type]]) {
      if (once) this.listeners[type].delete(listener);
      listener(event);
    }
  }
}

/**
 * A channel to `machine` for as long as the scope lasts, which tells the machine this end is done
 * when it closes. Frames go to the machine's newest connection until it answers, then to that
 * connection only; the channel closes with `CLOSE_UNREACHABLE` when the machine can't be reached and
 * `CLOSE_ENDED` when it ends the channel. Opening waits for this device's relay connection, and with
 * a `hello` for the machine's answer, and fails when either doesn't come. Long frames go in pieces
 * once the machine has sent some of its own (`framePieces`), and its pieces arrive joined.
 */
export const openTunnel = (
  account: Account["Service"],
  machine: DeviceId,
  options?: TunnelOptions,
): Effect.Effect<Socket.WebSocketLike, Socket.SocketError, Scope.Scope> =>
  Effect.gen(function* () {
    // Reconnecting to the relay, a frame would only be lost: wait for it instead.
    yield* account.changes.pipe(
      Stream.filter((state) => state._tag === "SignedIn" && state.connection === "online"),
      Stream.runHead,
      Effect.timeoutOrElse({
        duration: OPEN_WITHIN,
        orElse: () => Effect.fail(openFailed(unreachableReason.lost, "Timeout")),
      }),
    );
    const channel = yield* account.openChannel;
    // Subscribed before the first frame goes out, so no answer slips past.
    const events = yield* account.relayEvents;
    const outgoing = yield* Queue.unbounded<string>();
    let host: ConnectionId | undefined;
    /** Whether the machine takes frames in pieces, which it says by sending its own with `more`. */
    let piecewise = false;
    const joiner = new FrameJoiner();
    const target = (): TunnelAddress => (host === undefined ? { device: machine } : { connection: host });
    const sendClose = Effect.suspend(() => account.send({ _tag: "Close", to: target(), channel })).pipe(
      Effect.ignore,
    );

    const tunnel = new TunnelChannel(
      (data) => Queue.offerUnsafe(outgoing, data),
      () => Effect.runFork(sendClose),
    );
    const answered = yield* Deferred.make<void, Socket.SocketError>();
    let greeted = options?.hello === undefined;
    tunnel.addEventListener(
      "close",
      (event) => Deferred.doneUnsafe(answered, Exit.fail(openFailed(String(event.reason)))),
      { once: true },
    );

    // Frames go out in order; one the relay won't take means this device lost it.
    yield* Effect.gen(function* () {
      while (true) {
        const frame = yield* Queue.take(outgoing);
        for (const { data, more } of framePieces(frame, piecewise)) {
          const sent = yield* account
            .send({ _tag: "Send", to: target(), channel, data, more })
            .pipe(Effect.result);
          if (sent._tag === "Failure") return tunnel.ended(CLOSE_UNREACHABLE, unreachableReason.lost);
        }
      }
    }).pipe(Effect.forkScoped);

    yield* Effect.gen(function* () {
      while (tunnel.readyState === 1) {
        const event = yield* PubSub.take(events);
        switch (event._tag) {
          case "RelayLost":
            return tunnel.ended(CLOSE_UNREACHABLE, unreachableReason.lost);
          case "Gone":
            if (event.connection === host) return tunnel.ended(CLOSE_UNREACHABLE, unreachableReason.offline);
            break;
          case "Undeliverable":
            if (event.channel === channel)
              return tunnel.ended(CLOSE_UNREACHABLE, unreachableReason[event.reason]);
            break;
          case "Closed":
            if (event.channel === channel)
              return tunnel.ended(CLOSE_ENDED, "That computer ended the connection.");
            break;
          case "Receive": {
            if (event.channel !== channel) break;
            host ??= event.from.connection;
            if (event.more !== undefined) piecewise = true;
            const frame = joiner.add(event.data, event.more);
            if (frame === undefined) break;
            if (greeted) tunnel.received(frame);
            else {
              greeted = true;
              Deferred.doneUnsafe(answered, Exit.void);
            }
            break;
          }
          default:
            break;
        }
      }
    }).pipe(Effect.forkScoped);

    yield* Effect.addFinalizer(() => (tunnel.readyState === 1 ? sendClose : Effect.void));
    if (options?.hello !== undefined) {
      tunnel.send(options.hello);
      yield* Deferred.await(answered).pipe(
        Effect.timeoutOrElse({
          duration: OPEN_WITHIN,
          orElse: () => Effect.fail(openFailed(unreachableReason.silent, "Timeout")),
        }),
      );
    }
    return tunnel;
  });
