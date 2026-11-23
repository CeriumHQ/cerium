import { hashSecret, LINK_CALLBACK_PATH, randomToken, type CreateLinkRequest } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Option, Queue, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { Socket } from "effect/socket";

import { Account, Vault } from "../src/index.ts";

describe("manual account sign-in", () => {
  for (const format of ["code", "callback URL"] as const) {
    it.effect(`asks for manual handoff and claims the link with a pasted ${format}`, () =>
      Effect.gen(function* () {
        const relay = "https://relay.example";
        const id = randomToken(32);
        const code = randomToken(32);
        const url = `${relay}/link#${id}`;
        const callback = (link: string, value = code) =>
          `http://127.0.0.1:49152${LINK_CALLBACK_PATH}?link=${link}&code=${value}`;
        const lines = yield* Queue.unbounded<string>();
        const claim = yield* Deferred.make<{
          readonly authorization: string | null;
          readonly body: unknown;
        }>();
        const deviceId = randomToken(16);
        let socketAttempts = 0;
        let signedOut = false;
        let created: CreateLinkRequest | undefined;
        let saved: string | undefined;
        const client = HttpClient.make((request) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie);
            if (web.method === "DELETE") {
              assert.strictEqual(web.url, `${relay}/api/devices/${deviceId}`);
              signedOut = true;
              return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
            }
            const body = yield* Effect.promise(() => web.json());
            if (web.url === `${relay}/api/links`) {
              created = body as CreateLinkRequest;
              return HttpClientResponse.fromWeb(
                request,
                Response.json({ id, url, expiresAt: Date.now() + 60_000 }),
              );
            }
            assert.strictEqual(web.url, `${relay}/api/links/${id}/claim`);
            yield* Deferred.succeed(claim, { authorization: web.headers.get("Authorization"), body });
            return HttpClientResponse.fromWeb(
              request,
              Response.json({ _tag: "Linked", account: { id: "user_1" }, deviceId }),
            );
          }),
        );
        const account = Account.layer({
          relayUrl: relay,
          connect: false,
          device: {
            kind: "desktop",
            name: "Server",
            platform: "linux",
            channel: "stable",
            version: "1",
            headless: true,
          },
          handoff: { mode: "manual", listen: () => Effect.succeed({ next: Queue.take(lines) }) },
        }).pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
          Layer.provide(
            Layer.succeed(Vault, {
              read: Effect.sync(() => saved),
              write: (text) =>
                Effect.sync(() => {
                  saved = text;
                }),
            }),
          ),
          Layer.provide(
            Layer.succeed(Socket.WebSocketConstructor, () => {
              socketAttempts++;
              throw new Error("Account-only commands must not open the device socket");
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const { signIn } = yield* Account;
          assert.deepStrictEqual(yield* signIn, { url });
          assert.strictEqual(created?.handoff, "manual");
          assert.strictEqual(created?.device.headless, true);
          assert.notProperty(created, "callback");
        }).pipe(Effect.provide(account));
        // A process restarted while the user was confirming must still accept the pasted input.
        yield* Effect.gen(function* () {
          const { changes } = yield* Account;
          yield* Queue.offerAll(lines, [
            "",
            "too short",
            callback(randomToken(32), randomToken(32)),
            `  ${format === "code" ? code : callback(id)}  `,
          ]);
          const result = yield* Deferred.await(claim);
          assert.deepStrictEqual(result.body, { code });
          assert.match(result.authorization ?? "", /^Bearer /);
          assert.strictEqual(
            yield* Effect.promise(() => hashSecret(result.authorization!.slice(7))),
            created?.secretHash,
          );
          const state = Option.getOrThrow(
            yield* changes.pipe(
              Stream.filter((s) => s._tag === "SignedIn"),
              Stream.runHead,
            ),
          );
          assert.strictEqual(state.connection, "offline");
          yield* Effect.yieldNow;
          assert.strictEqual(socketAttempts, 0);
        }).pipe(Effect.provide(account));
        // Logout loads the saved credential in a separate command while the host may be connected.
        yield* Effect.gen(function* () {
          const { changes, signOut } = yield* Account;
          const current = Option.getOrThrow(yield* Stream.runHead(changes));
          assert.strictEqual(current._tag, "SignedIn");
          yield* Effect.yieldNow;
          yield* signOut;
          assert.isTrue(signedOut);
          assert.isUndefined(saved);
          assert.strictEqual(socketAttempts, 0);
        }).pipe(Effect.provide(account));
      }),
    );
  }
});
