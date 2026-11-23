import { request } from "node:http";

import { Account } from "@cerium/account";
import { LINK_CALLBACK_PATH, randomToken, type AccountState, type DeviceId } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";

import { thisMachine } from "../src/device.ts";
import {
  describeAccount,
  headlessFlags,
  headlessHandoff,
  manualHandoff,
  pastedCode,
  savedStatus,
  watchAccount,
} from "../src/headless.ts";

const link = randomToken(32);
const code = randomToken(32);
const deviceId = "dev_1" as DeviceId;
const returnTo = (id: string) => `https://relay.example/link#${id}`;

const signedIn = (connection: "connecting" | "online" | "offline"): AccountState => ({
  _tag: "SignedIn",
  account: { id: "acc_1" as never, email: "ada@example.com" },
  deviceId,
  connection,
  devices: [],
});

describe("headlessFlags", () => {
  it("reads sign-in, status, and host identity options", () => {
    assert.deepStrictEqual(headlessFlags(["node", "main.ts", "--sign-in"]), {
      signIn: true,
      status: false,
      headless: false,
    });
    const flags = headlessFlags(["--name= Lab computer ", "--headless"]);
    assert.deepStrictEqual(thisMachine("stable", "1.0", flags), {
      ...thisMachine("stable", "1.0"),
      name: "Lab computer",
      headless: true,
    });
    assert.strictEqual(
      thisMachine("stable", "1.0", headlessFlags(["--name= "])).name,
      thisMachine("stable", "1.0").name,
    );
    assert.deepStrictEqual(headlessFlags(["--status"]), { signIn: false, status: true, headless: false });
  });
});

describe("describeAccount", () => {
  it("says how the account stands", () => {
    assert.match(describeAccount({ _tag: "SignedOut" }, { deviceName: "mini" }), /--sign-in to link mini/);
    assert.strictEqual(
      describeAccount(signedIn("online"), { deviceName: "mini" }),
      "Signed in as ada@example.com on mini, online.",
    );
    const signingIn = describeAccount(
      { _tag: "SigningIn", url: "https://relay.example/link/1", expiresAt: Date.now() + 600_000 },
      { deviceName: "mini", port: 4567, paste: true },
    );
    assert.include(signingIn, "    https://relay.example/link/1");
    assert.include(signingIn, "Paste that address here.");
    assert.include(signingIn, "ssh -L 4567:127.0.0.1:4567");
  });

  it("names the device as the account does", () => {
    const state = {
      ...signedIn("offline"),
      devices: [{ id: deviceId, name: "Cupboard" }],
    } as unknown as AccountState;
    assert.strictEqual(
      describeAccount(state, { deviceName: "mini" }),
      "Signed in as ada@example.com on Cupboard, offline, retrying.",
    );
  });
});

describe("pastedCode", () => {
  it("takes the code from the address the page landed on", () => {
    assert.deepStrictEqual(
      pastedCode(`  http://127.0.0.1:4567${LINK_CALLBACK_PATH}?link=${link}&code=${code}\n`),
      { link, code },
    );
    assert.isUndefined(pastedCode(`http://127.0.0.1:4567/elsewhere?link=${link}&code=${code}`));
    assert.isUndefined(pastedCode("not an address"));
  });
});

it.effect("passes raw terminal input to a manual link and releases the listener", () =>
  Effect.gen(function* () {
    let stopped = false;
    const handoff = manualHandoff((onLine) => {
      onLine("  confirmation code  ");
      return () => {
        stopped = true;
      };
    });
    assert.equal(handoff.mode, "manual");
    yield* Effect.gen(function* () {
      const input = yield* handoff.listen({ returnTo });
      assert.isUndefined(input.callback);
      assert.equal(yield* input.next, "  confirmation code  ");
    }).pipe(Effect.scoped);
    assert.isTrue(stopped);
  }),
);

describe("headlessHandoff", () => {
  it.effect("takes a pasted address, and stops reading the terminal when done", () =>
    Effect.gen(function* () {
      let onLine: (line: string) => void = () => {};
      let stopped = false;
      let port: number | undefined;
      const handoff = headlessHandoff(
        (listener) => {
          onLine = listener;
          return () => void (stopped = true);
        },
        (heard) => (port = heard),
      );
      yield* Effect.gen(function* () {
        const listening = yield* handoff.listen({ returnTo });
        assert.strictEqual(port, listening.callback?.port);
        onLine("nothing useful");
        onLine(`http://127.0.0.1:${port}${LINK_CALLBACK_PATH}?link=${link}&code=${code}`);
        assert.deepStrictEqual(yield* listening.next, { link, code });
      }).pipe(Effect.scoped);
      assert.isTrue(stopped);
    }),
  );

  it.effect("still takes the code from a browser on this machine", () =>
    Effect.gen(function* () {
      const listening = yield* headlessHandoff(() => () => {}).listen({ returnTo });
      const port = listening.callback!.port;
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            request(
              {
                host: "127.0.0.1",
                port,
                path: `${LINK_CALLBACK_PATH}?link=${link}&code=${code}`,
                headers: { Host: `127.0.0.1:${port}` },
              },
              (response) => {
                response.resume();
                resolve();
              },
            )
              .on("error", reject)
              .end();
          }),
      );
      assert.deepStrictEqual(yield* listening.next, { link, code });
    }).pipe(Effect.scoped),
  );
});

describe("watchAccount", () => {
  const accountWith = (states: ReadonlyArray<AccountState>, onSignIn: () => void) =>
    Layer.succeed(Account, {
      changes: Stream.fromIterable(states),
      signIn: Effect.sync(() => {
        onSignIn();
        return { url: "https://relay.example/link/1" };
      }),
    } as unknown as Account["Service"]);

  it.live("prints each change once, and signs in at startup and when a link expires", () =>
    Effect.gen(function* () {
      const printed: Array<string> = [];
      let asked = 0;
      const states: ReadonlyArray<AccountState> = [
        { _tag: "SignedOut" },
        { _tag: "SigningIn", url: "https://relay.example/link/1", expiresAt: Date.now() + 1000 },
        { _tag: "SignedOut" },
        signedIn("connecting"),
        signedIn("online"),
        signedIn("online"),
      ];
      yield* Layer.build(
        watchAccount({
          signIn: true,
          describe: { deviceName: "mini" },
          print: (text) => printed.push(text),
        }).pipe(Layer.provide(accountWith(states, () => asked++))),
      );
      yield* Effect.sleep(10);
      assert.strictEqual(asked, 2);
      assert.lengthOf(printed, 5);
      assert.strictEqual(printed.at(-1), "Signed in as ada@example.com on mini, online.");
    }).pipe(Effect.scoped),
  );

  it.live("doesn't sign in unasked, nor again once signed off", () =>
    Effect.gen(function* () {
      let asked = 0;
      yield* Layer.build(
        watchAccount({ signIn: false, describe: { deviceName: "mini" }, print: () => {} }).pipe(
          Layer.provide(accountWith([{ _tag: "SignedOut" }], () => asked++)),
        ),
      );
      yield* Layer.build(
        watchAccount({ signIn: true, describe: { deviceName: "mini" }, print: () => {} }).pipe(
          Layer.provide(
            accountWith([signedIn("online"), { _tag: "SignedOut", error: "Removed." }], () => asked++),
          ),
        ),
      );
      yield* Effect.sleep(10);
      assert.strictEqual(asked, 0);
    }).pipe(Effect.scoped),
  );
});

describe("savedStatus", () => {
  const options = { relayUrl: "https://relay.example", deviceName: "mini", now: 1000 };

  it("reads a sign-in, a pending one, and none", () => {
    const linked = JSON.stringify({
      relayUrl: "https://relay.example",
      credential: "secret",
      account: { id: "acc_1", email: "ada@example.com" },
      deviceId,
    });
    const status = savedStatus(linked, options);
    assert.isTrue(status.signedIn);
    assert.include(status.text, "ada@example.com on mini");
    assert.notInclude(status.text, "secret");
    const pending = JSON.stringify({
      _tag: "Pending",
      relayUrl: "https://relay.example",
      link: { id: "l", url: "https://relay.example/link/1", expiresAt: 2000 },
      secret: "s",
    });
    assert.include(savedStatus(pending, options).text, "https://relay.example/link/1");
    assert.include(savedStatus(pending, { ...options, now: 3000 }).text, "--sign-in");
    assert.isFalse(savedStatus(undefined, options).signedIn);
    assert.include(savedStatus("{", options).text, "couldn't be read");
    assert.include(savedStatus(linked, { ...options, relayUrl: "https://other" }).text, "another relay");
  });
});
