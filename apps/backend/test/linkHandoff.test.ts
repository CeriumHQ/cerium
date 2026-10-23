import { request } from "node:http";

import { LINK_CALLBACK_PATH, randomToken } from "@cerium/protocol";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { loopbackHandoff } from "../src/linkHandoff.ts";

const link = randomToken(32);
const code = randomToken(32);
const returnTo = (id: string) => `https://relay.example/link#${id}`;

/** A GET as a browser sends it; node's own client, since `fetch` won't set `Host`. */
const get = (port: number, path: string, host = `127.0.0.1:${port}`) =>
  Effect.promise(
    () =>
      new Promise<{ status: number; location: string | undefined }>((resolve, reject) => {
        request({ host: "127.0.0.1", port, path, headers: { Host: host } }, (response) => {
          response.resume();
          resolve({ status: response.statusCode ?? 0, location: response.headers.location });
        })
          .on("error", reject)
          .end();
      }),
  );

describe("the loopback handoff", () => {
  it.effect("takes the page's code and sends the page back to the relay", () =>
    Effect.gen(function* () {
      const listening = yield* loopbackHandoff.listen({ returnTo });
      const port = listening.callback!.port;
      const response = yield* get(port, `${LINK_CALLBACK_PATH}?link=${link}&code=${code}`);
      assert.strictEqual(response.status, 302);
      assert.strictEqual(response.location, returnTo(link));
      assert.deepStrictEqual(yield* listening.next, { link, code });
    }).pipe(Effect.scoped),
  );

  it.live("ignores requests that aren't the page's, and takes no code from them", () =>
    Effect.gen(function* () {
      const listening = yield* loopbackHandoff.listen({ returnTo });
      const port = listening.callback!.port;
      const query = `?link=${link}&code=${code}`;
      // Another path, a short code, or a name other than the loopback address (DNS rebinding).
      assert.strictEqual((yield* get(port, `/other${query}`)).status, 404);
      assert.strictEqual((yield* get(port, `${LINK_CALLBACK_PATH}?link=${link}&code=short`)).status, 404);
      assert.strictEqual(
        (yield* get(port, `${LINK_CALLBACK_PATH}${query}`, `evil.example:${port}`)).status,
        404,
      );
      assert.isTrue(Option.isNone(yield* listening.next.pipe(Effect.timeoutOption(50))));
    }).pipe(Effect.scoped),
  );

  it.effect("listens again on the port a link made before a restart named", () =>
    Effect.gen(function* () {
      const port = yield* Effect.scoped(
        loopbackHandoff.listen({ returnTo }).pipe(Effect.map((listening) => listening.callback!.port)),
      );
      const again = yield* loopbackHandoff.listen({ callback: { port }, returnTo });
      assert.strictEqual(again.callback?.port, port);
    }).pipe(Effect.scoped),
  );
});
