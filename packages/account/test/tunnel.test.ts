import type {
  AccountState,
  ChannelId,
  ConnectionId,
  DeviceId,
  DeviceMessage,
  TunnelMessage,
} from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber, PubSub, SubscriptionRef } from "effect";
import { TestClock } from "effect/testing";

import type { Account, RelayEvent } from "../src/account.ts";
import { openTunnel } from "../src/tunnel.ts";

const desk = "desk" as DeviceId;
const channel = "channel" as ChannelId;
const host = "host" as ConnectionId;

const signedIn = (connection: "connecting" | "online"): AccountState =>
  ({ _tag: "SignedIn", account: { id: "account" }, deviceId: "phone", connection, devices: [] }) as never;

/** Just enough of a device's account for a tunnel: its state, what it sends and what the relay says. */
const fakeAccount = (connection: "connecting" | "online") =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.make(signedIn(connection));
    const events = yield* PubSub.unbounded<RelayEvent>();
    const sent: Array<DeviceMessage> = [];
    const account = {
      changes: SubscriptionRef.changes(state),
      send: (message: DeviceMessage) => Effect.sync(() => void sent.push(message)),
      relayEvents: PubSub.subscribe(events),
      openChannel: Effect.succeed(channel),
    } as unknown as Account["Service"];
    const relay = (message: TunnelMessage) => PubSub.publish(events, message);
    return { account, state, sent, relay };
  });

/** Lets the tunnel's fibers run until `done` holds. */
const until = (done: () => boolean) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 100 && !done(); turn++) yield* Effect.yieldNow;
  });

const answer = (data: string) =>
  ({ _tag: "Receive", from: { device: desk, connection: host }, channel, data }) as const;

describe("a tunnel with a hello", () => {
  it.effect("opens once the machine answers, without passing the answer on", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { account, sent, relay } = yield* fakeAccount("online");
        const opening = yield* openTunnel(account, desk, { hello: "hello" }).pipe(Effect.forkScoped);
        yield* until(() => sent.length > 0);
        assert.deepStrictEqual(sent, [{ _tag: "Send", to: { device: desk }, channel, data: "hello" }]);
        assert.isUndefined(opening.pollUnsafe());

        yield* relay(answer("pong"));
        const tunnel = yield* Fiber.join(opening);
        const received: Array<unknown> = [];
        tunnel.addEventListener("message", (event) => received.push(event.data));
        yield* relay(answer("frame"));
        yield* until(() => received.length > 0);
        assert.deepStrictEqual(received, ["frame"]);

        // Once it answered, frames go to that connection only.
        tunnel.send("next");
        yield* until(() => sent.length > 1);
        assert.deepStrictEqual(sent[1], { _tag: "Send", to: { connection: host }, channel, data: "next" });
      }),
    ),
  );

  it.effect("fails to open when the machine can't be reached", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { account, sent, relay } = yield* fakeAccount("online");
        const opening = yield* openTunnel(account, desk, { hello: "hello" }).pipe(Effect.forkScoped);
        yield* until(() => sent.length > 0);
        yield* relay({ _tag: "Undeliverable", channel, reason: "offline" });
        const exit = yield* Fiber.await(opening);
        assert.isTrue(Exit.isFailure(exit));
      }),
    ),
  );

  it.effect("fails to open when the machine stays silent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { account, sent } = yield* fakeAccount("online");
        const opening = yield* openTunnel(account, desk, { hello: "hello" }).pipe(Effect.forkScoped);
        yield* until(() => sent.length > 0);
        yield* TestClock.adjust("8 seconds");
        const exit = yield* Fiber.await(opening);
        assert.isTrue(Exit.isFailure(exit));
      }),
    ),
  );
});

describe("opening a tunnel", () => {
  it.effect("waits for this device's relay connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { account, state, sent } = yield* fakeAccount("connecting");
        const opening = yield* openTunnel(account, desk, { hello: "hello" }).pipe(Effect.forkScoped);
        yield* until(() => false);
        assert.deepStrictEqual(sent, []);
        yield* SubscriptionRef.set(state, signedIn("online"));
        yield* until(() => sent.length > 0);
        assert.lengthOf(sent, 1);
        yield* Fiber.interrupt(opening);
      }),
    ),
  );

  it.effect("fails when this device stays off the relay", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { account, sent } = yield* fakeAccount("connecting");
        const opening = yield* openTunnel(account, desk, { hello: "hello" }).pipe(Effect.forkScoped);
        yield* until(() => false);
        yield* TestClock.adjust("8 seconds");
        const exit = yield* Fiber.await(opening);
        assert.isTrue(Exit.isFailure(exit));
        assert.deepStrictEqual(sent, []);
      }),
    ),
  );
});
