import type { AccountId, AccountState, DeviceId } from "@cerium/protocol";
import type { RemoteUpdates } from "@cerium/rpc";
import { assert, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { EventEmitter } from "node:events";

import { runDesktopUpdate, watchDesktopUpdates } from "../src/desktopUpdates.ts";
import type { ParentPort } from "../src/shell.ts";

const office = "office" as DeviceId;
const account = Stream.succeed<AccountState>({
  _tag: "SignedIn",
  account: { id: "owner" as AccountId },
  deviceId: office,
  devices: [],
  connection: "online",
});
const check = { kind: "check" } as const;

it.effect("only forwards an update addressed to this signed-in computer", () =>
  Effect.gen(function* () {
    const messages: unknown[] = [];
    const port = Object.assign(new EventEmitter(), {
      postMessage: (message: unknown) => messages.push(message),
    });
    yield* Effect.flip(runDesktopUpdate(account, port, "laptop" as DeviceId, check));
    yield* Effect.flip(runDesktopUpdate(Stream.succeed({ _tag: "SignedOut" }), port, office, check));
    yield* Effect.flip(runDesktopUpdate(account, undefined, office, check));
    assert.isEmpty(messages);
    yield* runDesktopUpdate(account, port, office, check);
    assert.deepEqual(messages, [{ type: "desktopUpdate", command: check }]);
  }),
);

it.effect("a returning viewer reads the new shell state and drops its listener on disconnect", () =>
  Effect.gen(function* () {
    const events = new EventEmitter();
    let updates: RemoteUpdates = {
      version: "1.0.0",
      buildChannel: "stable",
      channel: "stable",
      manual: false,
      autoDownload: true,
      status: { kind: "installing", version: "2.0.0" },
      restart: "idle",
    };
    const port: ParentPort = Object.assign(events, {
      postMessage: (message: unknown) => {
        assert.deepEqual(message, { type: "desktopUpdate", command: null });
        events.emit("message", { data: { type: "desktopUpdateState", updates } });
      },
    });
    const read = watchDesktopUpdates(port).pipe(Stream.take(1), Stream.runCollect);
    assert.deepEqual(yield* read, [updates]);
    assert.equal(events.listenerCount("message"), 0);
    updates = { ...updates, version: "2.0.0", status: { kind: "current", checkedAt: 1 } };
    assert.deepEqual(yield* read, [updates]);
    assert.equal(events.listenerCount("message"), 0);
    assert.deepEqual(yield* Stream.runCollect(watchDesktopUpdates(undefined)), [null]);
  }),
);
