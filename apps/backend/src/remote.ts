import { Account, CLOSE_UNREACHABLE, openTunnel, unreachableReason, type RelayEvent } from "@cerium/account";
import { DeviceId, FrameJoiner, framePieces, type ChannelId, type TunnelAddress } from "@cerium/protocol";
import { TUNNEL_HELLO } from "@cerium/rpc";
import { Effect, Layer, Option, PubSub, Queue, Schema, Semaphore, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { NetAddress } from "effect/net";
import { Socket, SocketServer } from "effect/socket";

// Driving another machine. Through the relay, another device's UI calls
// this machine's backend as if it were its own: each tunnel channel becomes one RPC client of the
// tunnel's RPC server (`tunnelRpcServer` in rpc.ts). The other way, this machine's UI reaches
// another machine's backend through `/remote`, which pipes its RPC socket into a channel.

export const REMOTE_PATH = "/remote";

const closed = (code: number, reason?: string) =>
  new Socket.SocketError({ reason: new Socket.SocketCloseError({ code, closeReason: reason }) });

const text = new TextDecoder();
const asText = (chunk: Uint8Array | string) => (typeof chunk === "string" ? chunk : text.decode(chunk));

/**
 * A channel as a `Socket`: frames the relay delivers are read from `incoming`, and what's written
 * goes back through the relay to `to`, in pieces once `piecewise` says the other end takes them.
 */
const tunnelSocket = (
  account: Account["Service"],
  incoming: Queue.Queue<string, Socket.SocketError>,
  to: TunnelAddress,
  channel: ChannelId,
  piecewise: () => boolean,
): Socket.Socket => {
  // Answers to calls made at once are written at once: one frame's pieces go out before the next's.
  const oneFrameAtATime = Semaphore.makeUnsafe(1);
  const write = (chunk: Uint8Array | string | Socket.CloseEvent) =>
    Socket.isCloseEvent(chunk)
      ? account.send({ _tag: "Close", to, channel }).pipe(Effect.ignore)
      : Effect.forEach(
          framePieces(asText(chunk), piecewise()),
          ({ data, more }) => account.send({ _tag: "Send", to, channel, data, more }),
          { discard: true },
        ).pipe(
          oneFrameAtATime.withPermits(1),
          Effect.mapError((error) => closed(CLOSE_UNREACHABLE, error.message)),
        );
  return Socket.make({
    reader: Effect.succeed({
      pull: Queue.takeAll(incoming),
      upgrade: () =>
        Effect.fail(new Socket.SocketError({ reason: new Socket.SocketUpgradeError({ cause: "tunnel" }) })),
    }),
    writer: Effect.succeed({
      write,
      writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }),
    }),
  });
};

/**
 * Serves other devices' channels as sockets to the tunnel's RPC server. A channel starts with its
 * first frame and ends when the other side closes it, its connection goes, or the relay is lost.
 * Requires `Account`.
 */
export const TunnelSocketServer = Layer.effect(
  SocketServer.SocketServer,
  Effect.gen(function* () {
    const account = yield* Account;
    return SocketServer.SocketServer.of({
      // Not a real address: channels arrive through the relay connection.
      address: NetAddress.unixPathAddress("cerium-relay-tunnel"),
      run: (handler) =>
        Effect.gen(function* () {
          const events = yield* account.relayEvents;
          const sessions = new Map<
            string,
            {
              readonly connection: string;
              readonly incoming: Queue.Queue<string, Socket.SocketError>;
              readonly joiner: FrameJoiner;
              /** Whether the other end takes frames in pieces, which it says by sending its own with `more`. */
              piecewise: boolean;
            }
          >();
          const end = (key: string) =>
            Effect.gen(function* () {
              const session = sessions.get(key);
              if (session === undefined) return;
              sessions.delete(key);
              yield* Queue.fail(session.incoming, closed(1000));
            });

          const onEvent = (event: RelayEvent) =>
            Effect.gen(function* () {
              switch (event._tag) {
                case "Receive": {
                  // Answers on this machine's own channels are its pipes' business.
                  if (account.isOwnChannel(event.channel)) return;
                  const key = `${event.from.connection}:${event.channel}`;
                  let session = sessions.get(key);
                  if (session === undefined) {
                    const incoming = yield* Queue.unbounded<string, Socket.SocketError>();
                    const opened = {
                      connection: event.from.connection,
                      incoming,
                      joiner: new FrameJoiner(),
                      piecewise: false,
                    };
                    session = opened;
                    sessions.set(key, session);
                    const socket = tunnelSocket(
                      account,
                      incoming,
                      { connection: event.from.connection },
                      event.channel,
                      () => opened.piecewise,
                    );
                    yield* handler(socket).pipe(
                      Effect.ignore,
                      Effect.ensuring(Effect.sync(() => sessions.delete(key))),
                      Effect.forkScoped,
                    );
                  }
                  if (event.more !== undefined) session.piecewise = true;
                  const frame = session.joiner.add(event.data, event.more);
                  if (frame !== undefined) yield* Queue.offer(session.incoming, frame);
                  return;
                }
                case "Closed":
                  return yield* end(`${event.from.connection}:${event.channel}`);
                case "Gone":
                  for (const [key, session] of sessions) {
                    if (session.connection === event.connection) yield* end(key);
                  }
                  return;
                case "RelayLost":
                  for (const key of [...sessions.keys()]) yield* end(key);
                  return;
                default:
                  return;
              }
            });

          while (true) yield* onEvent(yield* PubSub.take(events));
        }).pipe(Effect.scoped),
    });
  }),
);

/**
 * `GET /remote?machine=<device>`: this machine's UI driving another machine. The UI speaks its usual
 * RPC over the socket, and each frame goes through a tunnel (`openTunnel`); the socket closes with
 * the tunnel's code and reason when it ends: `CLOSE_UNREACHABLE` when the machine can't be reached
 * and `CLOSE_ENDED` when it ends the channel. The UI's socket opens only once the machine has
 * answered, so an open socket means the machine is there.
 */
const pipe = Effect.gen(function* () {
  const account = yield* Account;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const machine = Option.getOrUndefined(
    Schema.decodeUnknownOption(DeviceId)(
      new URL(request.url, "http://localhost").searchParams.get("machine"),
    ),
  );
  if (machine === undefined) return HttpServerResponse.empty({ status: 400 });
  // A machine that isn't there is refused before the upgrade, so the UI's client backs off instead
  // of connecting and being closed again and again.
  const state = yield* account.changes.pipe(Stream.runHead, Effect.map(Option.getOrUndefined));
  const reachable =
    state?._tag === "SignedIn" &&
    state.connection === "online" &&
    state.devices.some((device) => device.id === machine && device.online && device.kind === "desktop");
  if (!reachable) return HttpServerResponse.text(unreachableReason.offline, { status: 503 });
  const opened = yield* openTunnel(account, machine, { hello: TUNNEL_HELLO }).pipe(Effect.result);
  if (opened._tag === "Failure") return HttpServerResponse.text(unreachableReason.silent, { status: 503 });

  const socket = yield* Effect.orDie(request.upgrade);
  const toUi = yield* socket.writer;
  const tunnel = yield* Socket.fromWebSocket(Effect.succeed(opened.success));
  const toMachine = yield* tunnel.writer;

  const fromMachine = Effect.gen(function* () {
    const pull = yield* Socket.readerString(tunnel);
    while (true) for (const frame of yield* pull) yield* toUi.write(frame).pipe(Effect.ignore);
  }).pipe(
    Effect.scoped,
    Effect.catchTag("SocketError", ({ reason }) =>
      toUi
        .write(
          reason._tag === "SocketCloseError"
            ? new Socket.CloseEvent(reason.code, reason.closeReason)
            : new Socket.CloseEvent(CLOSE_UNREACHABLE, unreachableReason.lost),
        )
        .pipe(Effect.ignore),
    ),
  );

  const fromUi = Effect.gen(function* () {
    const pull = yield* Socket.readerString(socket);
    while (true) yield* toMachine.writeAll(yield* pull);
  }).pipe(
    Effect.scoped,
    Effect.catchTag("SocketError", () => Effect.void),
  );

  yield* Effect.raceFirst(fromMachine, fromUi);
  return HttpServerResponse.empty();
}).pipe(Effect.scoped);

/** The `/remote` route, behind the same per-launch token as the UI's RPC (`requireToken`). */
export const remoteRoutes = (requireToken: Layer.Layer<never>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      yield* router.add("GET", REMOTE_PATH, pipe);
    }),
  ).pipe(Layer.provide(requireToken));
