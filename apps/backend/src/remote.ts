import { DeviceId, type ChannelId, type ConnectionId, type TunnelAddress } from "@cerium/protocol";
import { Effect, Layer, Option, PubSub, Queue, Schema, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { NetAddress } from "effect/net";
import { Socket, SocketServer } from "effect/socket";

import { Account, type TunnelEvent } from "./account.ts";

// Driving another machine (docs/architecture.md §14.8). Through the relay, another device's UI calls
// this machine's backend as if it were its own: each tunnel channel becomes one RPC client of the
// tunnel's RPC server (`tunnelRpcServer` in rpc.ts). The other way, this machine's UI reaches
// another machine's backend through `/remote`, which pipes its RPC socket into a channel.

export const REMOTE_PATH = "/remote";

/** Close codes the UI sees on `/remote`: the machine can't be reached, or it ended the channel. */
export const CLOSE_UNREACHABLE = 4100;
export const CLOSE_ENDED = 4101;

const closed = (code: number, reason?: string) =>
  new Socket.SocketError({ reason: new Socket.SocketCloseError({ code, closeReason: reason }) });

const text = new TextDecoder();
const asText = (chunk: Uint8Array | string) => (typeof chunk === "string" ? chunk : text.decode(chunk));

/**
 * A channel as a `Socket`: frames the relay delivers are read from `incoming`, and what's written
 * goes back through the relay to `to`.
 */
const tunnelSocket = (
  account: Account["Service"],
  incoming: Queue.Queue<string, Socket.SocketError>,
  to: TunnelAddress,
  channel: ChannelId,
): Socket.Socket => {
  const write = (chunk: Uint8Array | string | Socket.CloseEvent) =>
    Socket.isCloseEvent(chunk)
      ? account.send({ _tag: "Close", to, channel }).pipe(Effect.ignore)
      : account
          .send({ _tag: "Send", to, channel, data: asText(chunk) })
          .pipe(Effect.mapError((error) => closed(CLOSE_UNREACHABLE, error.message)));
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
          const events = yield* account.tunnel;
          const sessions = new Map<
            string,
            { readonly connection: string; readonly incoming: Queue.Queue<string, Socket.SocketError> }
          >();
          const end = (key: string) =>
            Effect.gen(function* () {
              const session = sessions.get(key);
              if (session === undefined) return;
              sessions.delete(key);
              yield* Queue.fail(session.incoming, closed(1000));
            });

          const onEvent = (event: TunnelEvent) =>
            Effect.gen(function* () {
              switch (event._tag) {
                case "Receive": {
                  // Answers on this machine's own channels are its pipes' business.
                  if (account.isOwnChannel(event.channel)) return;
                  const key = `${event.from.connection}:${event.channel}`;
                  let session = sessions.get(key);
                  if (session === undefined) {
                    const incoming = yield* Queue.unbounded<string, Socket.SocketError>();
                    session = { connection: event.from.connection, incoming };
                    sessions.set(key, session);
                    const socket = tunnelSocket(
                      account,
                      incoming,
                      { connection: event.from.connection },
                      event.channel,
                    );
                    yield* handler(socket).pipe(
                      Effect.ignore,
                      Effect.ensuring(Effect.sync(() => sessions.delete(key))),
                      Effect.forkScoped,
                    );
                  }
                  yield* Queue.offer(session.incoming, event.data);
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
                case "Undeliverable":
                  return;
              }
            });

          while (true) yield* onEvent(yield* PubSub.take(events));
        }).pipe(Effect.scoped),
    });
  }),
);

/** Messages the UI sees when its pipe to another machine closes. */
const unreachableReason: Record<"offline" | "forbidden" | "lost", string> = {
  offline: "That computer isn't connected to Cerium's cloud right now.",
  forbidden: "This computer can't reach that one: it isn't an approved computer of your account.",
  lost: "This computer lost its connection to Cerium's cloud.",
};

/**
 * `GET /remote?machine=<device>`: this machine's UI driving another machine. The UI speaks its usual
 * RPC over the socket; each frame goes through the relay to that machine's newest connection, and
 * once it answers, to that connection only. The socket closes with `CLOSE_UNREACHABLE` when the
 * machine can't be reached and `CLOSE_ENDED` when it ends the channel.
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
    state.devices.some(
      (device) => device.id === machine && device.approved && device.online && device.kind === "desktop",
    );
  if (!reachable) return HttpServerResponse.text(unreachableReason.offline, { status: 503 });

  const socket = yield* Effect.orDie(request.upgrade);
  const writer = yield* socket.writer;
  const channel = yield* account.openChannel;
  // Subscribed before the first frame goes out, so no answer slips past.
  const events = yield* account.tunnel;
  let host: ConnectionId | undefined;
  const target = (): TunnelAddress => (host === undefined ? { device: machine } : { connection: host });
  const close = (code: number, reason: string) =>
    writer.write(new Socket.CloseEvent(code, reason)).pipe(Effect.ignore);

  const fromMachine = Effect.gen(function* () {
    while (true) {
      const event = yield* PubSub.take(events);
      if (event._tag === "RelayLost") return yield* close(CLOSE_UNREACHABLE, unreachableReason.lost);
      if (event._tag === "Gone") {
        if (event.connection === host) return yield* close(CLOSE_UNREACHABLE, unreachableReason.offline);
        continue;
      }
      if (event.channel !== channel) continue;
      if (event._tag === "Undeliverable")
        return yield* close(CLOSE_UNREACHABLE, unreachableReason[event.reason]);
      if (event._tag === "Closed") return yield* close(CLOSE_ENDED, "That computer ended the connection.");
      host ??= event.from.connection;
      yield* writer.write(event.data).pipe(Effect.ignore);
    }
  });

  const toMachine = Effect.gen(function* () {
    const pull = yield* Socket.readerString(socket);
    while (true) {
      for (const frame of yield* pull) {
        const sent = yield* account
          .send({ _tag: "Send", to: target(), channel, data: frame })
          .pipe(Effect.result);
        if (sent._tag === "Failure") return yield* close(CLOSE_UNREACHABLE, unreachableReason.lost);
      }
    }
  }).pipe(Effect.catchTag("SocketError", () => Effect.void));

  yield* Effect.raceFirst(fromMachine, toMachine).pipe(
    Effect.ensuring(account.send({ _tag: "Close", to: target(), channel }).pipe(Effect.ignore)),
  );
  return HttpServerResponse.empty();
});

/** The `/remote` route, behind the same per-launch token as the UI's RPC (`requireToken`). */
export const remoteRoutes = (requireToken: Layer.Layer<never>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      yield* router.add("GET", REMOTE_PATH, pipe);
    }),
  ).pipe(Layer.provide(requireToken));
